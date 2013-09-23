"use strict"
if (typeof define !== 'function') {
    var define = require('amdefine')(module)
}
define([ 'require' ], function(require) {
    var _ = require('underscore');
    var Q = require('q');
    var JSCR = require('jscr-api/jscr-api');
    var utils = require('./git-utils');
    var FS = require('fs');

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

        loadProject : function(projectKey, options) {
            options = options || {};
            var path = this._getProjectPath(projectKey);
            var that = this;
            return that.gitUtils.checkRepository(path, {
                create : options.create
            })
            // If the required repository exist (or was successfully
            // initialized) then create and return a project
            // instance providing access to this repository.
            .then(function(exists) {
                if (exists) {
                    return that.newProject(projectKey);
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
            var path = this._getProjectPath(projectKey);
            return SysUtils.remove(path);
        },
        newProject : function(projectKey) {
            return new Impl.Project({
                gitUtils : this.gitUtils,
                projectKey : projectKey,
                projectPath : this._getProjectPath(projectKey)
            });
        }
    });

    Impl.Project = JSCR.Project.extend({
        initialize : function(options) {
            this.options = options || {};
            this.versionCounter = 0;
            this.resources = {};
        },
        getProjectKey : function() {
            return JSCR.normalizePath(this.options.projectKey);
        },
        getResourceHistory : function(path, create) {
            var history = this.resources[path];
            if (!history && create) {
                history = [];
                this.resources[path] = history;
            }
            return history;
        },
        getResource : function(path, options) {
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
        /* ---------------------------------------------------------------- */
        // Public methods
        loadResource : function(path, options) {
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
        }

    });

    return JSCR;
});
