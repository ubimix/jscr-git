"use strict"
if (typeof define !== 'function') {
    var define = require('amdefine')(module)
}
define([ 'require' ], function(require) {
    var Yaml = require('yamljs');
    var _ = require('underscore');
    var Q = require('q');
    var JSCR = require('jscr-api/jscr-api');
    var FS = require('fs');
    var Path = require('path');
    var LRU = require('lru-cache');
    var utils = require('./git-utils');
    var filestats = require('./git-filestats');

    var DateUtils = utils.DateUtils;
    var SysUtils = utils.SysUtils;
    var GitUtils = utils.GitUtils;

    var Impl = JSCR.Implementation.Git = {};

    /**
     * Static utility methods for content serialization/de-serialization and
     * path transformations. It is used internally by the Git-based repository
     * implementation.
     */
    var ContentUtils = Impl.ContentUtils = {

        /** Name of the field with the content */
        contentField : 'description',

        /**
         * Transforms the given resource into a string and returns the resuting
         * value;
         */
        serializeResource : function(resource) {
            var properties = resource.getProperties();
            var content = properties[ContentUtils.contentField] || '';
            content = content.trim();

            // Create a copy of properties without the content field
            var copy = JSCR.copy(properties);
            delete copy[ContentUtils.contentField];

            // Copy all other property family values in the same 'copy'
            // Keys from other property families are prefixed by the family
            // name.
            var families = resource.getPropertyFamilies();
            _.each(families, function(family) {
                if (family == 'sys' || family == 'properties')
                    return;
                var obj = resource.getPropertyFamily(family);
                _.each(obj, function(value, key) {
                    key = family + '.' + key;
                    copy[key] = value;
                })
            })

            var str = Yaml.stringify(copy, 1, 2);
            return content + '\n\n-------\n\n' + str;
        },

        /**
         * Splits the given content string to two parts - a content part and
         * properties part
         */
        _split : function(content) {
            content = content || '';
            var array = content.split(/\n*-+\n*/gim);
            content = array[0];
            var str = '';
            for ( var i = 1; i < array.length; i++) {
                if (str.length > 0)
                    str += '\n';
                str += array[i];
            }
            return [ content, str ];
        },

        /**
         * Deserialize content from string and fills the specified resource with
         * loaded values
         */
        deserializeResource : function(content, resource) {
            var array = ContentUtils._split(content);
            content = array[0];
            var str = array[1];
            var yaml = {};
            try {
                yaml = Yaml.parse(str) || {};
            } catch (e) {
                console.log('PARSE ERROR: ', e)
                yaml = {};
            }
            _.each(yaml, function(value, key) {
                var obj = yaml;
                var param = null;
                var family = 'properties';
                var idx = key.indexOf('.');
                if (idx > 0) {
                    family = key.substring(0, idx);
                    key = key.substring(idx + 1);
                }
                var obj = resource.getPropertyFamily(family, true);
                obj[key] = value;
            });
            var properties = resource.getProperties();
            properties[ContentUtils.contentField] = content;
            return resource;
        },

        /**
         * This method transforms a path to physical file into a logical path to
         * a resource. Especially this method removes the file name if this name
         * is equal to the index file name.
         */
        toResourcePath : function(resourcePath, indexFileName) {
            var path = JSCR.normalizePath(resourcePath);
            if (path == indexFileName) {
                return '';
            }
            var fileName = path;
            var idx = path.lastIndexOf('/');
            if (idx >= 0) {
                fileName = path.substring(idx + 1);
                if (indexFileName == fileName) {
                    path = path.substring(0, idx);
                    path = JSCR.normalizePath(path);
                }
            }
            return path;
        },

        /**
         * Transforms a logical resource path to a physical file path. This
         * method adds an index file to the path if the last segment of this
         * logical path does not contain an extension.
         */
        toFilePath : function(resourcePath, indexFileName) {
            var path = JSCR.normalizePath(resourcePath);
            if (path == '') {
                return indexFileName;
            }
            var fileName = path;
            var idx = path.lastIndexOf('/');
            if (idx > 0) {
                fileName = path.substring(idx + 1);
            }
            if (fileName.indexOf('.') < 0) {
                path += '/' + indexFileName;
            }
            return path;
        }
    }

    /* -------------------------------------------------------------------- */

    /**
     * This connection gives access to a Git-based workspace implementation
     */
    Impl.WorkspaceConnection = JSCR.WorkspaceConnection.extend({
        initialize : function(options) {
            this.options = options || {};
        },

        /**
         * 'Connects' to the workspace and returns a promise containing the
         * requested workspace
         */
        connect : function() {
            if (!this.workspace) {
                this.workspace = this.newWorkspace();
            }
            return Q(this.workspace);
        },

        /** Creates and returns a new workspace instance */
        newWorkspace : function() {
            return new Impl.Workspace(this);
        }

    });

    /* -------------------------------------------------------------------- */

    /** A Git-base workspace implementation */
    Impl.Workspace = JSCR.Workspace
            .extend({

                /**
                 * Initializes the internal project cache, instantiates
                 * Git-utility object etc.
                 */
                initialize : function(connection) {
                    this.connection = connection;
                    this.options = this.connection.options || {};
                    this.projects = {};
                    this.gitUtils = new GitUtils();
                    this.gitUtils.onNewRepositoryDir = _.bind(
                            this.onNewRepositoryDir, this);
                    this.projectCache = LRU({
                        max : 500,
                        maxAge : 1000 * 60 * 60
                    });
                },

                /**
                 * This method is called by an internal GitUtils instance. It is
                 * used to check if newly created folders contain index files.
                 * If such files do not exist then this method creates them.
                 */
                onNewRepositoryDir : function(path, folderPath) {
                    var file = this._getIndexFileName();
                    var p = Path.join(path, folderPath);
                    p = Path.join(p, file);
                    return SysUtils.fileExists(p).then(function(exists) {
                        if (exists)
                            return true;
                        return SysUtils.writeTextFile(p, '');
                    });
                },

                /** Returns the internal GitUtils method */
                getGitUtils : function() {
                    return this.gitUtils;
                },

                /**
                 * Returns the name of the index files.
                 */
                _getIndexFileName : function() {
                    return 'index.md';
                },

                /** Returns the root directory for the repository */
                _getRootDir : function() {
                    var path = this.options.rootDir || './repository';
                    return path;
                },

                /**
                 * Normalizes the specified string and transforms it into a
                 * valid project name
                 */
                _normalizeProjectKey : function(projectKey) {
                    projectKey = JSCR.normalizePath(projectKey);
                    projectKey = projectKey.replace('/[\/\\\r\n\t]/gi', '-')
                            .replace(/^\.+/g, '').replace(/\.+$/g, '');
                    return projectKey;
                },

                /**
                 * Transforms the given projet key into a full file path to the
                 * folder containing the requested project repository
                 */
                _getProjectPath : function(projectKey) {
                    var root = this._getRootDir();
                    projectKey = this._normalizeProjectKey(projectKey);
                    var path = Path.join(root, JSCR.normalizePath(projectKey));
                    return path;
                },

                /**
                 * Creates and returns a new commit object. The following fields
                 * should be defined in the resulting instance:
                 * 
                 * <pre>
                 *  - comment: comment for the initial repository commit
                 *  - author: information about the author in the form 
                 *            'FirstName LastName &lt;emailaddress@email.com&gt;'
                 *  - files: a map containing file names with the corresponding 
                 *           text content   
                 * </pre>
                 */
                newInitialCommit : function(options) {
                    options = options || {};
                    if (options.initialCommit)
                        return options.initialCommit;
                    // FIXME:
                    return {
                        comment : 'Initial commit',
                        author : 'system <system@system>',
                        files : {
                            '.gitignore' : [ '/*~', '/.settings', '/.lock' ]
                                    .join('\n'),
                            '.root' : ''
                        }
                    };
                },

                /* == Public API implementation == */

                /**
                 * Loads a project corresponding to the specified name. If such
                 * a project does not exist and the 'options.create' flag is
                 * <code>true</code> then this method creates and returns a
                 * newly created project.
                 */
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
                    // initialized) then create and return a project instance
                    // providing
                    // access to this repository.
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

                /**
                 * Loads and returns existing projects.
                 */
                loadProjects : function(options) {
                    var root = this._getRootDir();
                    var that = this;
                    return Q.nfcall(FS.readdir, root).then(function(dirlist) {
                        return Q.all(_.map(dirlist, function(dir) {
                            var projectKey = Path.basename(dir);
                            return that.loadProject(projectKey);
                        }));
                    });
                },

                /** Deletes a project with the specified project key */
                deleteProject : function(projectKey, options) {
                    projectKey = this._normalizeProjectKey(projectKey);
                    this.projectCache.del(projectKey);
                    var path = this._getProjectPath(projectKey);
                    return SysUtils.remove(path);
                },

                /** Creates and returns a new project instance. */
                newProject : function(projectKey) {
                    return new Impl.Project(this, {
                        projectKey : projectKey,
                        projectPath : this._getProjectPath(projectKey)
                    });
                }
            });

    /* -------------------------------------------------------------------- */
    /**
     * A Git-based project implementation.
     */
    Impl.Project = JSCR.Project.extend({

        /**
         * Initializes internal fields: sets the specified parent workspace and
         * options.
         */
        initialize : function(workspace, options) {
            this.workspace = workspace;
            this.options = options || {};
            this.versionCounter = 0;
            this.resources = {};
        },

        /**
         * Acquires an internal mutex lock before the specified promise and
         * unlock it after the execution is finished
         */
        _lock : function(method, f) {
            return f();
        },

        /**
         * Returns the name of the index files.
         */
        _getIndexFileName : function() {
            return this.workspace._getIndexFileName();
        },

        /**
         * This method transforms a path to physical file into a logical path to
         * a resource. Especially this method removes the file name if this name
         * is equal to the index file name.
         * 
         * @see ContentUtils.toResourcePath
         */
        _toResourcePath : function(path) {
            var index = this._getIndexFileName();
            return ContentUtils.toResourcePath(path, index);
        },

        /**
         * Transforms a logical resource path to a physical file path. This
         * method adds an index file to the path if the last segment of this
         * logical path does not contain an extension.
         * 
         * @see ContentUtils.toFilePath
         */
        _toFilePath : function(path) {
            var index = this._getIndexFileName();
            return ContentUtils.toFilePath(path, index);
        },

        /**
         * Updates the file statistics since the last synchronization
         */
        _updateResourceStats : function(reload) {
            var that = this;
            if (!that.fileStats) {
                that.fileStatVersion = null;
                // that.fileStats = new
                // filestats.AsyncFileStats();
                that.fileStats = new filestats.SyncFileStats();
            }
            var path = that.getProjectPath();
            var params = [ 'whatchanged', '--date=iso' ];
            // Loads modifications only since the last loaded commit or all
            // files.
            if (!reload && that.fileStatVersion
                    && that.fileStatVersion.versionId) {
                params.push(that.fileStatVersion.versionId + '..');
            }
            var gitUtils = this.getGitUtils();
            var promises = Q();
            var handleCommit = function(commit) {
                var version = {
                    versionId : commit.versionId,
                    timestamp : commit.timestamp,
                    author : commit.author
                }
                if (!that.fileStatVersion
                        || that.fileStatVersion.timestamp < version.timestamp) {
                    that.fileStatVersion = version;
                }
                var files = GitUtils.parseModifiedResources(commit.data);
                _.each(files, function(fileStatus, filePath) {
                    promises = promises.then(function() {
                        var path = that._toResourcePath(filePath);
                        return that.fileStats.updateStatus(path, fileStatus,
                                version);
                    })
                })
                return promises;
            };
            return gitUtils.runGitAndCollectCommits(path, params, handleCommit)
            // Finish collecting data before returning results to the client.
            .then(function() {
                return promises;
            })
            // Return the final statistics
            .then(function() {
                return that.fileStats;
            });
        },

        /**
         * Loads statistics for all files managed by this project
         */
        _loadResourceStats : function() {
            var that = this;
            if (that.fileStats) {
                return Q(that.fileStats);
            }
            return that._updateResourceStats();
        },

        /**
         * Stores content for the the specified file in the current repository
         * and updates the stat. Returns the stat about the current file.
         */
        _saveFiles : function(commit) {
            var that = this;
            var projectPath = that.getProjectPath();
            var files = {};
            if (commit.files) {
                _.each(commit.files, function(content, path) {
                    var filePath = that._toFilePath(path);
                    files[filePath] = content;
                })
            }
            commit.files = files;
            var gitUtils = that.getGitUtils();
            return gitUtils
            // Writes the file in the repository
            .writeAndCommitRepository(projectPath, commit)
            // Updates file statistics
            .then(function() {
                return that._updateResourceStats();
            });
        },

        /**
         * Creates and returns a new resource corresponding to the specified
         * path, with the given status and content
         */
        _newResource : function(filePath, stat, content) {
            var resource = JSCR.resource();
            var resourcePath = this._toResourcePath(filePath);
            resource.setPath(resourcePath);
            var sys = resource.getSystemProperties();
            _.each(stat, function(value, key) {
                sys[key] = _.clone(value);
            })
            var properties = resource.getProperties();
            ContentUtils.deserializeResource(content, resource);
            return resource;
        },

        /**
         * Returns the current timestamp in a readable format. It is used to
         * automatically create commit comments.
         */
        _getCurrentTime : function() {
            return DateUtils.formatDate(new Date().getTime());
        },

        /** Returns a commit info for the specified file */
        _newCommitInfo : function(path, options, files) {
            files = files || {};
            options = options || {};
            return {
                comment : options.comment || 'Commit "' + path + '" at '
                        + this._getCurrentTime() + '.',
                author : this._getCurrentUser(options),
                files : files
            }
        },

        /**
         * Returns the info about the current user activating a new commit
         */
        _getCurrentUser : function(options) {
            // FIXME: get the user ID from the specified options
            var author = options.author;
            if (!author) {
                author = (this.options || {})[author];
            }
            return author || 'system <system@system>';
        },

        /* ---------------------------------------------------------------- */
        // Public methods
        /**
         * Returns the key of this project.
         */
        getProjectKey : function() {
            return JSCR.normalizePath(this.options.projectKey);
        },

        /**
         * Returns the full path to this project.
         */
        getProjectPath : function() {
            var projectKey = this.getProjectKey();
            return this.workspace._getProjectPath(projectKey);
        },

        /**
         * Returns a GitUtils instance used to access to underlying Git
         * repositories.
         */
        getGitUtils : function() {
            return this.workspace.getGitUtils();
        },

        /**
         * An internal utility method used to create a new resource using the
         * file statistics and path to this logical resource
         */
        _loadResourceContent : function(resourcePath, stat, version) {
            if (!stat)
                return null;
            var that = this;
            var path = that._toFilePath(resourcePath);
            var projectPath = that.getProjectPath();
            var gitUtils = that.getGitUtils();
            return gitUtils
            // Read the file content
            .readFromRepository(projectPath, path, version)
            // Transforms the loaded raw text content into a resource
            .then(function(content) {
                return that._newResource(resourcePath, stat, content);
            });
        },

        /**
         * Loads the specified resource. If this resource does not exist and the
         * 'options.create' flag is <code>true</code> then this method creates
         * a new resource and returns it. Otherwise this method returns
         * <code>null</code>.
         */
        loadResource : function(filePath, options) {
            var that = this;
            return that._lock('loadResource', function() {
                var resourcePath = that._toResourcePath(filePath);
                options = options || {};
                var create = options.create ? true : false;
                var projectPath = that.getProjectPath();
                var gitUtils = that.getGitUtils();
                return that._loadResourceStats()
                // Load the current status of the file
                .then(function(fileStats) {
                    return fileStats.getStat(resourcePath);
                })
                // If the file does not exist then create it (if the
                // 'options.create' flug is true)
                .then(
                        function(stat) {
                            if (stat || !create)
                                return stat;
                            var files = {};
                            files[resourcePath] = '';
                            var initialCommit = that._newCommitInfo(
                                    resourcePath, options, files);
                            return that._saveFiles(initialCommit) //
                            .then(function(fileStats) {
                                return fileStats.getStat(resourcePath);
                            });
                        })
                // Finally read the file content and transform it in a resource
                .then(function(stat) {
                    return that._loadResourceContent(resourcePath, stat);
                })
            });
        },

        /**
         * Loads and returns map with resources corresponding to the specified
         * paths. The returned object is a map with path/resource pairs.
         * 
         * @param pathList
         *            list of paths for resources to load
         * @param options
         *            options used to load resources; if the 'options.create'
         *            flag is <code>true</code> then not existing resources
         *            will be automatically created by this method
         */
        loadResources : function(pathList, options) {
            var that = this;
            return that._lock('loadResources', function() {
                var result = {};
                var promise = Q();
                _.each(pathList, function(filePath) {
                    var resourcePath = that._toResourcePath(filePath);
                    promise = promise.then(function() {
                        return that
                        // Load a resource for the specified path
                        .loadResource(resourcePath, options)
                        // Adds this resource to the resulting map
                        .then(function(resource) {
                            result[resourcePath] = resource;
                            return resource;
                        })
                    });
                });
                return promise.then(function() {
                    return result;
                });
            })
        },

        /** Returns a list of all children for the specified resource. */
        loadChildResources : function(path, options) {
            var that = this;
            var projectPath = that.getProjectPath();
            var resourcePath = that._toResourcePath(path);
            var indexFileName = that._getIndexFileName();
            var gitUtils = that.getGitUtils();
            return gitUtils.listFolderContent(projectPath, resourcePath) //
            .then(function(childNames) {
                var paths = [];
                _.map(childNames, function(childName) {
                    if (indexFileName != childName && childName != '.git') {
                        var childPath = resourcePath + '/' + childName;
                        paths.push(childPath);
                    }
                })
                return that.loadResources(paths, options);
            }) //
            .then(function(resources) {
                var result = {};
                _.each(resources, function(resource, path) {
                    path = that._toResourcePath(path);
                    if (resource) {
                        result[path] = resource;
                    }
                });
                return result;
            });
        },

        /** Deletes the specified resource and returns true/false */
        deleteResource : function(path, options) {
            var that = this;
            return that._lock('deleteResource', function() {
                var projectPath = that.getProjectPath();
                var filePath = that._toFilePath(path);
                var gitUtils = that.getGitUtils();
                var commit = {
                    comment : 'Remove file "' + path + '".',
                    author : that._getCurrentUser(options),
                    files : [ filePath ]
                }
                return gitUtils.removeAndCommit(projectPath, commit)
                // Updates file statistics
                .then(function() {
                    return that._updateResourceStats();
                }).then(function() {
                    return true;
                })
            });
        },

        /**
         * Serializes and stores the content of this resource. The specified
         * options object should contain the following fields used to build
         * commit comments:
         * 
         * <pre>
         * - comment - commit comment (optional)
         * - author - information about the author of this modification 
         *            (in the form 'John Smith &lt;john.smith@foo.bar&gt;')
         * </pre>
         */
        storeResource : function(resource, options) {
            resource = JSCR.resource(resource);
            var that = this;
            var projectPath = that.getProjectPath();
            var path = resource.getPath();
            var resourcePath = that._toResourcePath(path);
            var indexFileName = that._getIndexFileName();
            var gitUtils = that.getGitUtils();

            var content = ContentUtils.serializeResource(resource);
            var files = {};
            files[resourcePath] = content;
            var commit = that._newCommitInfo(resourcePath, options, files);
            return that._lock('storeResource', function() {
                return that._saveFiles(commit)
                // Load file commit info
                .then(function(fileStats) {
                    return fileStats.getStat(resourcePath);
                })
                // Read the file content and transform it into a resource
                .then(function(stat) {
                    return that._loadResourceContent(resourcePath, stat);
                })
            });
        },

        // ----------------------------------------------
        // History management

        /***********************************************************************
         * Returns all repository revision in the specified range of versions.
         * If the range is not definded then this method returns all
         * revisitions. Range is defined by 'from' and 'to' option parameters.
         * Default values for 'from' is '0' (which means - the begginning of the
         * history) and for 'to' the default value is 'now' (the latest
         * version).
         * 
         * <pre>
         * {
         *     from : '123215',
         *     to : '1888888',
         *     order : 'asc'
         * }
         * </pre>
         */
        loadModifiedResources : function(options) {
            var that = this;
            options = options || {};
            var from = JSCR.version(options.from || 0);
            var to = JSCR.version(options.to);
            return that._lock('loadModifiedResources', function() {
                return that._loadResourceStats().then(function(stats) {
                    return stats.getAll().then(function(result) {
                        return result;
                    });
                })
            });
        },

        /**
         * Returns the history (list of versions) for a resource with the
         * specified path.
         */
        loadResourceHistory : function(path, options) {
            var that = this;
            options = options || {};
            var from = JSCR.version(options.from || 0);
            var to = JSCR.version(options.to);
            var projectPath = that.getProjectPath();
            var resourcePath = that._toResourcePath(path);
            var filePath = that._toFilePath(resourcePath);
            var indexFileName = that._getIndexFileName();
            var params = [ 'log', '--', filePath ];
            var gitUtils = that.getGitUtils();
            var history = [];
            return that._lock('loadResourceHistory', function() {
                return gitUtils.runGitAndCollectCommits(projectPath, params,
                        function(commit) {
                            var version = JSCR.version(commit);
                            if (version.inRange(from, to)) {
                                history.push(version);
                            }
                        }).then(function() {
                    return history;
                })
            });
        },

        /** Returns content (revisions) of the specified resource */
        loadResourceRevisions : function(path, options) {
            var that = this;
            var versions = options.versions || [];
            versions = _.map(versions, function(v) {
                v = JSCR.version(v);
                return v;
            });
            var resourcePath = that._toResourcePath(path);
            var filePath = that._toFilePath(resourcePath);
            return Q.all(_.map(versions, function(version) {
                return that._loadResourceStats()
                // Load the current status of the file
                .then(function(fileStats) {
                    return fileStats.getStat(resourcePath);
                })
                // Load a content of the required
                .then(
                        function(stat) {
                            stat = _.clone(stat);
                            stat.updated = version;
                            var versionId = version ? version.versionId : null;
                            return that._loadResourceContent(resourcePath,
                                    stat, versionId);

                        })
            }));
        },

        // ----------------------------------------------
        // Search

        // query : { term : 'Hello', sortBy :
        // 'properties.label', order : 'asc'
        // }
        searchResources : function(query) {
            return that._lock('searchResources', function() {
                return this.notImplemented.apply(this, arguments)
            });

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
