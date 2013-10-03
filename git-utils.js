"use strict"
if (typeof define !== 'function') {
    var define = require('amdefine')(module)
}
var deps = [ 'require', 'underscore', 'q', 'fs', 'path', 'child_process',
        'moment' ];
define(deps, function(require) {

    var moment = require('moment');
    var _ = require('underscore');
    var Q = require('q');
    var ChildProcess = require('child_process');
    var FS = require('fs');
    var Path = require('path');

    /* =================================================================== */
    /** System utilities */
    var SysUtils = {
        /**
         * Runs the specified system command and notifies about all new data
         * blocks the given listener. This method should be used to retrieve big
         * quantity of data returne if (err.code == 'EEXIST') return true; d by
         * the executed command.
         * 
         * @param command
         *            the command to execute
         * @param params
         *            parameters of the command
         * @param options
         *            nodejs options for an external process
         * @param dataCallback
         *            the callback to notify about new data provided by the
         *            executed command
         */
        runWithDataCallback : function(command, params, options, dataCallback) {
            var deferred = Q.defer();
            var child = ChildProcess.spawn(command, params, options);
            child.stdout.addListener('data', dataCallback);
            var stderr = [];
            var exitCode = 0;
            var stacktrace = new Error().stack
            child.stderr.addListener('data', function(text) {
                // console.log('ERROR:' + text);
                stderr[stderr.length] = text.toString();
            });
            child.addListener('exit', function(code) {
                exitCode = code;
            });
            child.addListener('close', function() {
                var msg = stderr.join();
                if (exitCode != 0 && msg != '') {
                    var err = new Error(command + ' ' + params.join(' '));
                    err.stderr = stderr;
                    deferred.reject(err);
                } else {
                    deferred.resolve({
                        exitCode : exitCode
                    });
                }
            });
            child.stdin.end();
            return deferred.promise;
        },

        /**
         * Runs the specified system command and returns a promise to return an
         * object with execution results. The returns object has the following
         * structure:
         * 
         * <pre>
         *  - stdout - an array of text blocks send by the executed command 
         *  - exitCode - an exit code of the process
         * </pre>
         * 
         * @param command
         *            the command to execute
         * @param params
         *            parameters of the command
         * @param options
         *            nodejs options for an external process
         * 
         */
        run : function(command, params, options) {
            var stdout = [];
            return SysUtils.runWithDataCallback(command, params, options,
                    function(data) {
                        stdout.push(data.toString());
                    }).then(function(result) {
                result.stdout = stdout;
                return result;
            }).fail(function(error) {
                error.stdout = stdout;
                throw error;
            });
        },

        /* ---------------------------------------------- */
        /* File system utilities */

        /**
         * Returns a promise for a boolean value showing if the specified file
         * or directory exists
         */
        fileExists : function(path) {
            var deferred = Q.defer();
            FS.exists(path, function(exists) {
                deferred.resolve(exists);
            })
            return deferred.promise;
        },

        /**
         * Writes a new content for the file.
         * 
         * @param file
         *            path to the file
         * @param content
         *            content of the file to write
         * @param dirCallback
         *            an optional callback to call when parent folders for the
         *            file are created
         */
        writeTextFile : function(file, content, dirCallback) {
            var that = this;
            var array = file.split(Path.sep);
            var name = array.pop();
            var dir = Path.normalize(array.join('/'));
            return SysUtils.mkdirs(dir, dirCallback).then(function() {
                var filePath = Path.join(dir, name);
                return Q.nfcall(FS.writeFile, filePath, content);
            })
        },

        /** Returns a promise for a list of child files and folders. */
        ls : function(path) {
            return Q.nfcall(FS.readdir, path);
        },

        /**
         * Create all directories corresponding to this path.
         * 
         * @param path
         *            full path to the folder hierarchy to create
         * @param callback
         *            an optional callback which should be called when a new
         *            folder is created; this callback takes a full path to the
         *            newly created folder
         */
        mkdirs : function(path, callback) {
            path = Path.normalize(path);
            var array = path.split(Path.sep);
            var currentPath = '';
            var promise = Q();
            _.each(array, function(segment) {
                var p = currentPath = Path.join(currentPath, segment);
                promise = promise.then(function() {
                    return Q.nfcall(FS.mkdir, p).then(function() {
                        return callback ? callback(p) : true;
                    }).fail(function(err) {
                        if (err.code == 'EEXIST')
                            return true;
                        throw err;
                    });
                });
            });
            return promise;
        },

        /**
         * Recursively removes the specified file or a directory with all
         * content.
         */
        remove : function(path) {
            path = Path.normalize(path);
            return SysUtils.fileExists(path).then(function(exists) {
                if (!exists)
                    return false;
                var promise = null;
                var dir = FS.statSync(path).isDirectory();
                if (dir) {
                    // Recursively removes this directory
                    promise = Q
                    // Get list of all children
                    .nfcall(FS.readdir, path).then(function(list) {
                        list = list || [];
                        return Q.all(_.map(list, function(file) {
                            var curPath = Path.join(path, file);
                            return SysUtils.remove(curPath);
                        }));
                    })
                    // Finally - removes the directory itself
                    .then(function() {
                        // Removes the directory
                        return Q.nfcall(FS.rmdir, path);
                    });
                } else {
                    // Delete file
                    promise = Q.nfcall(FS.unlink, path);
                }
                // Returns true when all operations finished.
                return promise.fail(function(error) {
                    if (error.code != 'ENOENT') {
                        throw error;
                    }
                }).then(function() {
                    return true;
                });
            })
        }
    }

    /* =================================================================== */
    /** Date manipulation utilities */
    var DateUtils = {
        formatDate : function(timestamp) {
            if (!timestamp) {
                throw new Error('Timestamp is not defined');
            }
            var result = moment(timestamp).utc().format();
            return result;
        },
        parseDate : function(str) {
            var val = moment(str);
            if (!val) {
                return null;
            }
            return val.utc().valueOf();
        }
    }

    /* =================================================================== */
    /** Git-specific utilities and methods */
    function GitUtils(options) {
        this.options = options || {};
    }
    /* Static utility methods */
    _.extend(GitUtils, {

        /**
         * Extracts file names and their status from a data block of the
         * 'whatchanged' Git command. The returned object contains file paths
         * and the corresponding status. Possible status values: 'A' - added,
         * 'M' - modified, 'D' - deleted.
         * 
         * @param dataLines
         *            array of data lines returned by the 'whatchanged' Git
         *            command
         */
        parseModifiedResources : function(dataLines) {
            var files = {};
            _.each(dataLines, function(line) {
                var array = line.split(/\t/);
                var status = array[0].charAt([ array[0].length - 1 ]);
                var file = array[1];
                files[file] = status;
            })
            return files;
        },

        /**
         * Splits the given commit message to individual fields and returns the
         * result as an object.
         * 
         * <pre>
         * Structure of the returned object:
         *      - versionId - (string: SHA1) unique identifier of the version 
         *      - timestamp - (long) timestamp of the commit
         *      - author    - (string: John Smith &lt;john.smith@yahoo.com&gt;)
         *                    author of this commit
         *      - comment   - (string[]) array with commit comment lines
         *      - data      - (string[]) array with optional data  
         * </pre>
         */
        parseCommitMessage : function(text) {
            function remove(str, regex) {
                if (!str)
                    return '';
                return str.replace(regex, '');
            }
            var results = {
                versionId : null,
                timestamp : null,
                author : null,
                comment : [],
                data : []
            }
            var array = text.split(/[\r\n]/gim);
            var i = 0;
            results.versionId = remove(array[i++], /^commit\s+/gi);
            results.author = remove(array[i++], /^Author:\s+/gi);
            var date = remove(array[i++], /^Date:\s+/);
            results.timestamp = DateUtils.parseDate(date);
            var fields = [ 'comment', 'data' ];
            var fieldPos = 0;
            var field = null;
            for (; i < array.length; i++) {
                var str = array[i];
                if ((!str || str == '') && (fieldPos < fields.length)) {
                    field = fields[fieldPos++];
                    continue;
                }
                str = str.replace(/^\s*(.*)\s*$/gim, '$1')
                if (!field)
                    continue;
                if (str != '') {
                    results[field].push(str);
                }
            }
            return results;
        },

        /**
         * Parses list of commit messages and returns an array of objects
         * describing each individual commit. For object format - see the
         * #parseCommitMessage method.
         */
        parseCommitMessages : function(txt) {
            var result = [];
            var array = txt.split(/^commit /gim);
            _.each(array, function(commit) {
                if (!commit)
                    return;
                commit = commit.replace(/^\s+/gi, '').replace(/\s+$/gi, '');
                if (commit == '') {
                    return;
                }
                commit = 'commit ' + commit;
                var info = GitUtils.parseCommitMessage(commit);
                result.push(info);
            })
            return result;
        }

    })

    _.extend(GitUtils.prototype, {

        /**
         * Returns a git command to execute in a separate process. This method
         * uses the 'gitCommand' field defined in the options for this class. If
         * this field is not defined then it uses just 'git'.
         */
        _getGitCommand : function() {
            if (!this.gitCommand) {
                this.gitCommand = this.options.gitCommand || 'git';
            }
            return this.gitCommand;
        },

        /**
         * Returns the path of the repository corresponding to the specified
         * path
         */
        _getRepositoryPath : function(path) {
            var result = path;
            var rootDir = this.options.rootDir;
            if (rootDir) {
                result = Path.join(rootDir, path);
            }
            result = Path.normalize(result);
            return result;
        },

        /* ---------------------------------------------- */
        /* Generic commands */

        /** Runs a Git command in the specified folder */
        runGit : function(path, params) {
            var git = this._getGitCommand();
            return SysUtils.run(git, params, {
                cwd : path
            });
        },

        /** Runs a Git command in the specified folder */
        runGitAndCollect : function(path, params, dataCallback) {
            var git = this._getGitCommand();
            return SysUtils.runWithDataCallback(git, params, {
                cwd : path
            }, dataCallback);
        },

        /* =============================================================== */
        /* Repository-specific commands. */

        /* --------------------------------------------------------------- */
        /* Repository creation/checking etc */

        /** Creates a new git repository in the specified file */
        initRepository : function(path) {
            var that = this;
            var repositoryPath = that._getRepositoryPath(path);
            return SysUtils.fileExists(repositoryPath).then(function(exists) {
                if (exists) {
                    return true;
                } else
                    return SysUtils.mkdirs(repositoryPath).then(function() {
                        return true;
                    });
            }).then(function() {
                return that.runGit(repositoryPath, [ 'init' ]);
            })
        },

        /**
         * Returns <code>true</code> if the specified directory is under the
         * version control.
         */
        repositoryExists : function(path) {
            var that = this;
            var gitDir = that._getRepositoryPath(path) + '/.git';
            return SysUtils.fileExists(gitDir);
        },

        /**
         * Checks that the specified repository exist and tries to create it if
         * it does not exist yet.
         */
        checkRepository : function(path, options) {
            options = options || {};
            var that = this;
            return that.repositoryExists(path).then(function(exists) {
                if (exists || !options.create)
                    return exists;
                var promise = that.initRepository(path);
                promise = promise.then(function() {
                    var initialCommit = options.initialCommit;
                    if (!initialCommit) {
                        return true;
                    }
                    var commitInfo = initialCommit;
                    if (_.isFunction(initialCommit)) {
                        commitInfo = initialCommit();
                    }
                    return that
                    //
                    .writeAndCommitRepository(path, commitInfo);
                });
                promise = promise.then(function() {
                    return that.repositoryExists(path);
                });
                return promise;
            });
        },

        /* --------------------------------------------------------------- */
        /*  */

        /**
         * Commits the specified repository.
         * 
         * <pre>
         * Commit object structure:
         * {
         * comment: 'Initial commit',
         * author: 'John Smith &lt;john.smith@yahoo.com&gt;'
         * }
         * </pre>
         * 
         * @param path
         *            path to the repository
         * @param commit
         *            commit object defining commit parameters
         */
        commitRepository : function(path, commit) {
            var that = this;
            commit = commit || {};
            var repositoryPath = that._getRepositoryPath(path);
            var comment = commit.comment || 'Initial commit';
            var params = [ 'commit', '-a', '-m', comment ];
            if (commit.author) {
                var authorCommand = '--author="' + commit.author + '"';
                params.push(authorCommand);
            }
            return that.runGit(repositoryPath, params).fail(function(error) {
                var msg = (error.stdout ? error.stdout.join() : '');
                if (msg.indexOf('nothing to commit') >= 0) {
                    return 0;
                } else {
                    throw error;
                }
            });
        },

        /**
         * Adds all changed files to the repository.
         * 
         * @param path
         *            the path to the git repository
         */
        addChangesToRepository : function(path) {
            var that = this;
            var repositoryPath = that._getRepositoryPath(path);
            return that.runGit(repositoryPath, [ 'add', '.' ]);
        },

        /* --------------------------------------------------------------- */
        /* Content reading/writing */

        /**
         * Writes the content of the specified files in the repository and adds
         * them to the git history. This method DOES NOT commit new files, it
         * just adds them. To commit the result use the 'commitRepository'
         * method.
         * 
         * @param path
         *            path to the repository
         * @param files
         *            this object contains file paths and the corresponding file
         *            text content
         */
        writeToRepository : function(path, files) {
            var that = this;
            var repositoryPath = that._getRepositoryPath(path);
            var promise = Q.all(_.map(files, function(content, file) {
                var filePath = Path.join(repositoryPath, file);
                return SysUtils.writeTextFile(filePath, content, function(
                        dirPath) {
                    var folderPath = dirPath.substring(repositoryPath.length);
                    return that.onNewRepositoryDir(path, folderPath);
                });
            }))
            return promise.then(function() {
                return that.addChangesToRepository(repositoryPath);
            });
        },

        /**
         * This method is called when a new (empty) folder is created in a
         * repository
         */
        onNewRepositoryDir : function(path, folderPath) {
            return true;
        },

        /**
         * Removes specified files from the repository and adds. This method
         * DOES NOT commit new files, it just adds them. To commit the result
         * use the 'commitRepository' method.
         * 
         * @param path
         *            path to the repository
         * @param files
         *            a list of file names to remove
         */
        removeFromRepository : function(path, files) {
            var that = this;
            var repositoryPath = that._getRepositoryPath(path);
            var params = [ 'rm' ].concat(files || []);
            return that.runGit(repositoryPath, params);
        },

        /** Loads and return the text content of files with the specified paths. */
        readFromRepository : function(path, filePath, version) {
            var that = this;
            var repositoryPath = that._getRepositoryPath(path);
            filePath = './' + Path.normalize(filePath);
            version = version || 'HEAD';
            return that.runGit(repositoryPath,
                    [ 'show', version + ':' + filePath + '' ]).then(
                    function(result) {
                        var content = result.stdout.join();
                        return content;
                    });
        },

        /**
         * Writes the specified files to the disc and commits them.
         */
        writeAndCommitRepository : function(path, commit) {
            var that = this;
            var files = commit.files || {};
            return that
            // Write files to the repository
            .writeToRepository(path, files)
            // Commit the repository
            .then(function() {
                return that.commitRepository(path, commit).then(function(v) {
                    return v;
                });
            });
        },

        /**
         * Removes the specified files commits the result. The specified
         * 'commit' object should contain a 'files' field with a list of files
         * names to remove.
         */
        removeAndCommit : function(path, commit) {
            var that = this;
            var files = commit.files || [];
            return that
            // Removes files from the repository
            .removeFromRepository(path, files)
            // Commit the repository
            .then(function() {
                return that.commitRepository(path, commit).then(function(v) {
                    return v;
                });
            });
        },

        /** Reads and returns names of all child files of the specified folder */
        listFolderContent : function(path, filePath, makePath) {
            var that = this;
            var repositoryPath = that._getRepositoryPath(path);
            filePath = Path.normalize(filePath);
            var fullPath = Path.join(repositoryPath, filePath);
            return SysUtils.ls(fullPath).then(function(names) {
                if (!makePath)
                    return names;
                return _.map(names, function(name) {
                    return Path.join(filePath, name);
                });
            })
        },

        /* --------------------------------------------------------------- */
        /* Commit info loading */

        /**
         * Runs a Git command returning commit information. This method notifies
         * about individual commits using the provided listener which SHOULD
         * return a promise.
         * 
         * @param path
         *            the path to the repository
         * @param params
         *            an array with git params
         * @param commitListener
         *            the listener used to handle individual commits; it SHOULD
         *            return a promise
         */
        runGitAndCollectCommits : function(path, params, commitListener) {
            var p = Q();
            return this.runGitAndCollect(path, params, function(data) {
                var txt = data.toString();
                var commits = GitUtils.parseCommitMessages(txt);
                _.each(commits, function(commit) {
                    p = p.then(function() {
                        var result = commitListener(commit);
                        return result || true;
                    });
                });
            }).then(function() {
                return p;
            });
        },

        /**
         * Loads history of the specified file and notifies the given listener
         * about individual commits.
         * 
         * @param path
         *            the path to the repository
         * @param filePath
         *            path to the path for which commits should be loaded
         * @param commitListener
         *            the listener used to handle individual commits; it SHOULD
         *            return a promise
         */
        loadFileCommits : function(path, filePath, commitListener) {
            var params = [ 'log', '--', filePath ];
            return this.runGitAndCollectCommits(path, params, commitListener);
        },

        /**
         * Loads and returns the last repository commit.
         * 
         * @param path
         *            the path to the repository
         */
        loadRepositoryLastCommit : function(path) {
            var params = [ 'log', '--name-status', 'HEAD^..HEAD' ];
            return this.runGitAndCollectCommits(path, params, commitListener);
        }

    });

    return {
        DateUtils : DateUtils,
        SysUtils : SysUtils,
        GitUtils : GitUtils
    }

});