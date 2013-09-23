"use strict"
if (typeof define !== 'function') {
    var define = require('amdefine')(module)
}
define([ 'require' ], function(require) {
    var _ = require('underscore');
    var Q = require('q');
    var JSCR = require('jscr-api/jscr-api');
    var FS = require('fs');
    var LRU = require('lru-cache');
    var utils = require('./git-utils');
    var filestats = require('./git-filestats');

    var DateUtils = utils.DateUtils;
    var SysUtils = utils.SysUtils;
    var GitUtils = utils.GitUtils;

    /* ----------------------------------------------------------------------- */
    var Impl = JSCR.Implementation.Git = {};

    Impl.WorkspaceConnection = JSCR.WorkspaceConnection.extend({
        initialize : function(options) {
            this.options = options || {};
        },
        connect : function() {
            if (!this.workspace) {
                this.workspace = this.newWorkspace();
            }
            return Q(this.workspace);
        },
        newWorkspace : function() {
            return new Impl.Workspace(this.options);
        }
    });

    Impl.Workspace = JSCR.Workspace.extend({
        initialize : function(options) {
            this.options = options || {};
            this.projects = {};
            this.gitUtils = new GitUtils();
            this.projectCache = LRU({
                max : 500,
                maxAge : 1000 * 60 * 60
            });
        },
        getGitUtils : function() {
            return this.gitUtils;
        },
        _getRootDir : function() {
            var path = this.options.rootDir || './repository';
            return path;
        },
        _normalizeProjectKey : function(projectKey) {
            projectKey = projectKey.replace('/[\/\\\r\n\t]/gi', '-').replace(
                    /^\.+/g, '').replace(/\.+$/g, '');
            return projectKey;
        },
        _getProjectPath : function(projectKey) {
            var root = this._getRootDir();
            projectKey = this._normalizeProjectKey(projectKey);
            var path = root + JSCR.normalizePath(projectKey);
            return path;
        },

        newInitialCommit : function(options) {
            options = options || {};
            if (options.initialCommit)
                return options.initialCommit;
            // FIXME: get the
            return {
                comment : 'Initial commit',
                author : 'system <system@system>',
                files : {
                    '.gitignore' : [ '/*~', '/.settings' ].join('\n')
                }
            };
        },

        loadProject : function(projectKey, options) {
            options = options || {};
            projectKey = this._normalizeProjectKey(projectKey);
            var project = this.projectCache.get(projectKey);
            if (project) {
                return Q(project);
            }
            var path = this._getProjectPath(projectKey);
            var that = this;
            var gitUtils = this.getGitUtils();
            return gitUtils.checkRepository(path, {
                create : options.create,
                initialCommit : function() {
                    return that.newInitialCommit(options);
                }
            })
            // If the required repository exist (or was successfully
            // initialized) then create and return a project
            // instance providing access to this repository.
            .then(function(exists) {
                if (exists) {
                    project = that.newProject(projectKey);
                    that.projectCache.set(projectKey, project);
                    return project;
                } else {
                    return Q(null);
                }
            });
        },
        loadProjects : function() {
            var root = this._getRootDir();
            var that = this;
            return Q.nfcall(FS.readdir, root).then(function(dirlist) {
                return Q.all(_.map(dirlist, function(dir) {
                    var projectKey = Path.basename(dir);
                    return that.loadProject(projectKey);
                }));
            });
        },
        deleteProject : function(projectKey, options) {
            projectKey = this._normalizeProjectKey(projectKey);
            this.projectCache.del(projectKey);
            var path = this._getProjectPath(projectKey);
            return SysUtils.remove(path);
        },
        newProject : function(projectKey) {
            return new Impl.Project(this, {
                projectKey : projectKey,
                projectPath : this._getProjectPath(projectKey)
            });
        }
    });

    Impl.Project = JSCR.Project.extend({
        initialize : function(workspace, options) {
            this.workspace = workspace;
            this.options = options || {};
            this.versionCounter = 0;
            this.resources = {};
        },
        getProjectKey : function() {
            return JSCR.normalizePath(this.options.projectKey);
        },
        getProjectPath : function() {
            var projectKey = this.getProjectKey();
            return this.workspace._getProjectPath(projectKey);
        },
        getGitUtils : function() {
            return this.workspace.getGitUtils();
        },

        /** Loads statistics for all files managed by this project */
        _loadFileStats : function() {
            var that = this;
            if (that.fileStats) {
                return Q(that.fileStats);
            }
            that.fileStats = new filestats.AsyncFileStats();
            var path = that.getProjectPath();
            var params = [ 'whatchanged', '--date=iso' ];
            return that.fileStats.runGitAndCollectCommits(
                    path,
                    params,
                    function(commit) {
                        var promises = Q();
                        var version = {
                            versionId : commit.versionId,
                            timestamp : commit.timestamp,
                            author : commit.author
                        }
                        var files = GitUtils
                                .parseModifiedResources(commit.data);
                        _.each(files, function(fileStatus, filePath) {
                            promises = promises.then(function() {
                                return that.fileStats.updateStatus(filePath,
                                        fileStatus, version);
                            })
                        })
                        return promises;
                    })
            //
            .then(function() {
                return that.fileStats;
            });
        },

        /* ---------------------------------------------------------------- */
        // Public methods
        loadResource : function(path, options) {
            // TODO:
            // - get content
            // - parse content as YAML
            // -- set geospacial data in "geometry.coordinates" field
            // -- set all other fields in "properties.*"
            // - get version metadata => workspace.loadFileMetadata
            // -- set version info in "sys.created" and "sys.updated"
            var resource = this.getResource(path, options);
            return Q(resource);
        },
        // 'resources' is a map of paths and the corresponding
        // resources
        loadResources : function(pathList, options) {
            var list = [];
            _.each(pathList, function(path) {
                var resource = this.getResource(path, options);
                list.push(resource);
            }, this);
            return Q(list);
        },

        loadChildResources : function(path, options) {
            var path = JSCR.normalizePath(path);
            var result = {};
            _.each(this.resources, function(history, resourcePath) {
                if (resourcePath.indexOf(path) == 0 && (path != resourcePath)) {
                    var str = resourcePath.substring(path.length);
                    if (str.indexOf('/') <= 0) {
                        var resourceObj = this.getResource(resourcePath);
                        result[resourcePath] = resourceObj;
                    }
                }
            }, this);
            return Q(result);
        },
        // Result: true/false
        deleteResource : function(path, options) {
            var path = JSCR.normalizePath(path);
            var resource = this.resources[path];
            delete this.resources[path];
            var result = resource != null;
            return Q(result);
        },

        storeResource : function(resource, options) {
            resource = JSCR.resource(resource);
            var path = resource.getPath();
            var history = this.getResourceHistory(path, true);
            var version = this.getProjectVersion(true);
            resource.updateVersion(version);
            history.push(resource);
            return Q(resource);
        },

        // ----------------------------------------------
        // History management

        // { from : '123215', to : '1888888', order : 'asc' }
        loadModifiedResources : function(options) {
            // TODO: see sandbox->updateRepositoryHistory
            // var params = [ 'whatchanged', '--date=iso' ];
            // var range = [
            // 'f4d60c01f916beafd9c2743a5bc739bb90eda38e..38779907ad0d5ff6742511f760281e0240e6ea85'
            // ];
            // range = [
            // '5dc2f121542d814eeee2ae8d8101fabed07d31ed..3ae0843a133cbf13d8cc699c9d4e9271ea44b2ed'
            // ];
            // range = [ '--since="2013-09-19 20:27:20 +0200"' ];
            // range = [ '--since="2013-09-20 00:00:00 +0200"' ]
            // range = [ '--since="2013-09-20 00:00:00 +0200"',
            // '--until="2013-09-20 12:00:00 +0200"' ]
            // return w.runGitAndCollectCommits(path, params, function(commit) {
            // var promises = Q();
            // var version = {
            // versionId : commit.versionId,
            // timestamp : commit.timestamp,
            // author : commit.author
            // }
            // var files = GitUtils.parseModifiedResources(commit.data);
            // _.each(files, function(fileStatus, filePath) {
            // promises = promises.then(function() {
            // return fileStat.updateStatus(filePath, fileStatus, version);
            // })
            // })
            // return promises;
            // });

            var from = JSCR.version(options.from || 0);
            var to = JSCR.version(options.to);
            var result = {};
            _.each(this.resources, function(history) {
                var resource = _.find(history.reverse(), function(revision) {
                    var version = revision.getUpdated();
                    return version.inRange(from, to);
                }, this);
                if (resource) {
                    var path = resource.getPath();
                    result[path] = resource;
                }
            }, this);
            return Q(result);
        },
        loadResourceHistory : function(path, options) {
            // TODO:
            // var fileName = 'README.txt';
            // var params = [ 'log', '--', fileName ];
            // var counter = 1;
            // console.log('===================================');
            // console.log('File history:')
            // return w.runGitAndCollectCommits(path, params, function(commit) {
            // console.log(' * ' + (counter++), formatVersion(commit));
            // })
            options = options || {};
            var from = JSCR.version(options.from || 0);
            var to = JSCR.version(options.to);
            path = JSCR.normalizePath(path);
            var result = [];
            var history = this.getResourceHistory(path, false);
            if (history) {
                _.each(history, function(revision) {
                    var version = revision.getUpdated();
                    if (version.inRange(from, to)) {
                        result.push(version);
                    }
                });
            }
            return Q(result);
        },
        loadResourceRevisions : function(path, options) {
            // TODO:
            // for each revision in the list:
            // git show 37c61925a86887319f0a6b5c1466848f42cf8a5c:README.txt
            var versions = {};
            var timestamps = {};
            var versions = options.versions || [];
            _.each(versions, function(v) {
                v = JSCR.version(v);
                var versionId = v.getVersionId();
                var timestamp = v.getTimestamp();
                versions[versionId] = v;
                timestamps[timestamp] = v;
            });

            path = JSCR.normalizePath(path);
            var result = [];
            var history = this.getResourceHistory(path, false);
            if (history) {
                _.each(history, function(revision) {
                    var version = revision.getUpdated();
                    var versionId = version.getVersionId();
                    var timestamp = version.getTimestamp();
                    if (versions[versionId] || timestamps[timestamp]) {
                        result.push(revision);
                    }
                }, this);
            }
            return Q(result);
        },

        // ----------------------------------------------
        // Search

        // query : { term : 'Hello', sortBy :
        // 'properties.label', order : 'asc'
        // }
        searchResources : function(query) {
            return this.notImplemented.apply(this, arguments);

            // ResultSet is an object with the following fields:
            // - totalNumber - number of found resources
            // resultSet.loadNext(function(err, result){
            // // result has the following fields:
            // // - hasNext - true/false
            // // - resources is an array of resources
            //                
            // })
        },

        /* Private methods */
        getResourceHistory : function(path, create) {
            // TODO:
            // var fileName = 'README.txt';
            // var params = [ 'log', '--', fileName ];
            // var counter = 1;
            // console.log('===================================');
            // console.log('File history:')
            // return w.runGitAndCollectCommits(path, params, function(commit) {
            // console.log(' * ' + (counter++), formatVersion(commit));
            // })

            var history = this.resources[path];
            if (!history && create) {
                history = [];
                this.resources[path] = history;
            }
            return history;
        },
        getResource : function(path, options) {
            // TODO:
            // git show HEAD^^^:README.txt

            options = options || {};
            path = JSCR.normalizePath(path);
            var history = this.getResourceHistory(path, options.create);
            var resource = null;
            if (history) {
                if (history.length == 0) {
                    resource = this.newResource(path, options);
                    history.push(resource);
                } else {
                    resource = history[history.length - 1];
                }
            }
            if (resource) {
                resource = resource.getCopy();
            }
            return resource;
        },
        getProjectVersion : function(inc) {
            if (!this.version || inc) {
                this.version = JSCR.version({
                    timestamp : new Date().getTime(),
                    versionId : '' + (this.versionCounter++)
                });
            }
            return this.version;
        },
        // TODO: options parameter not used ?
        newResource : function(path, options) {
            var resource = JSCR.resource();
            resource.setPath(path);
            var version = this.getProjectVersion();
            resource.updateVersion(version);
            return resource;
        },

    });

    return JSCR;
});
