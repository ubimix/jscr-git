'use strict'
var _ = require('underscore');
var Q = require('q');
var Path = require('path');
var ChildProcess = require('child_process');
var Fs = require('fs');
var utils = require('../git-utils');

var DateUtils = utils.DateUtils;
var SysUtils = utils.SysUtils;
var GitUtils = utils.GitUtils;

function Store() {
    this.index = {};
}
_.extend(Store.prototype, {
    getAsync : function() {
        var keys = _.toArray(arguments);
        return Q.all(_.map(keys, function(key) {
            return this.get(key);
        }, this)).then(function(values) {
            var result = {};
            for ( var i = 0; i < keyList.length; i++) {
                result[keyList[i]] = values[i];
            }
            return result;
        });
    },
    getAll : function() {
        var copy = _.clone(this.index);
        return Q(copy);
    },
    get : function() {
        var result = {};
        var keys = _.toArray(arguments);
        _.each(keys, function(key) {
            result[key] = this.index[key];
        }, this)
        return Q(result);
    },
    put : function(key, value) {
        this.index[key] = value;
        return Q(true);
    },
    del : function(key) {
        var result = key in this.index;
        if (result) {
            delete this.index[key];
        }
        return Q(result);
    }
});

function AbstractFileStats() {
}
_.extend(AbstractFileStats.prototype, {
    _doUpdateInfo : function(info, status, version) {
        var result = true;
        if (status == 'A') {
            info.created = version;
        } else if (status == 'M') {
            if (!info.updated || (info.updated.timestamp < version.timestamp)) {
                info.updated = version;
            }
        } else if (status == 'D') {
            info.deleted = version;
        } else {
            result = false;
        }
        return result;
    }
});

function SyncFileStats() {
    this.index = {};
}
_.extend(SyncFileStats.prototype, AbstractFileStats.prototype);
_.extend(SyncFileStats.prototype, {
    getAll : function() {
        var copy = _.clone(this.index);
        return Q(copy);
    },
    updateStatus : function(path, status, version) {
        var info = this.index[path];
        if (!info) {
            info = {};
            this.index[path] = info;
        }
        var result = this._doUpdateInfo(info, status, version);
        return Q(result);
    }
});

function AsyncFileStats() {
    this.store = this._newStore();
}
_.extend(AsyncFileStats.prototype, AbstractFileStats.prototype);
_.extend(AsyncFileStats.prototype, {
    _newStore : function() {
        return new Store();
    },
    getAll : function() {
        return this.store.getAll();
    },
    updateStatus : function(path, status, version) {
        var that = this;
        return that.store.get(path).then(function(result) {
            var info = result[path];
            if (!info) {
                info = {};
            }
            var result = that._doUpdateInfo(info, status, version);
            return that.store.put(path, info);
        });
    }
});

var FileStats;
FileStats = SyncFileStats;
FileStats = AsyncFileStats;

// * List of all child elements 'repo', 'path'
// * List of all versions for a file (timestamp, versionId, author):
// 'repo', 'path'
// * Get a list of all modifications

var fileStat = new FileStats();
var w = new GitUtils();
var path = '/home/kotelnikov/workspaces/ubimix/jscr-api';
// path = '/home/kotelnikov/workspaces/ubimix/djinko'
path = './tmp/sandbox'
var initialCommit = {
    comment : 'Initial commit',
    author : 'John Smith <john.smith@yahoo.com>',
    files : {
        'README.txt' : 'This is a simple readme file',
        'LICENSE.txt' : 'WDYFW'
    }
};

function removeRepository() {
    return SysUtils.remove('./tmp/sandbox').then(function(result) {
        console.log('"./tmp/sandbox" folder was removed:', result);
    })
}

function createRepository() {
    return w.checkRepository(path, {
        create : true,
        initialCommit : initialCommit
    });
}

function updateRepository() {
    var stamp = DateUtils.formatDate(new Date().getTime());
    var contentStamp = stamp;
    contentStamp = '';
    return w.writeAndCommitRepository(path, {
        comment : 'A new commit ' + stamp,
        author : 'James Bond <james.bond@mi6.gov.uk>',
        files : {
            'README.txt' : 'Modified README content. ' + contentStamp,
            'foo/bar/toto.txt' : 'Foo-bar content',
            'test.txt' : 'A new test file'
        }
    });
}

function updateRepositoryHistory() {
    function splitter(txt) {
        var promises = Q();
        var commits = GitUtils.parseCommitMessages(txt);
        _.each(commits, function(commit) {
            var version = {
                versionId : commit.versionId,
                timestamp : commit.timestamp,
                author : commit.author
            }
            var files = GitUtils.parseModifiedResources(commit.data);
            _.each(files, function(fileStatus, filePath) {
                promises = promises
                        .then(function() {
                            return fileStat.updateStatus(filePath, fileStatus,
                                    version);
                        })
            })
        });
        return promises;
    }
    var params = [ 'whatchanged', '--date=iso' ];

    var range = [ 'f4d60c01f916beafd9c2743a5bc739bb90eda38e..38779907ad0d5ff6742511f760281e0240e6ea85' ];
    range = [ '5dc2f121542d814eeee2ae8d8101fabed07d31ed..3ae0843a133cbf13d8cc699c9d4e9271ea44b2ed' ];
    range = [ '--since="2013-09-19 20:27:20 +0200"' ];
    range = [ '--since="2013-09-20 00:00:00 +0200"' ]
    range = [ '--since="2013-09-20 00:00:00 +0200"',
            '--until="2013-09-20 12:00:00 +0200"' ]

    // params = params.concat(range);
    var p = Q();
    return w.runGitAndCollect(path, params, function(data) {
        var txt = data.toString();
        p = p.then(function() {
            return splitter(txt);
        });
    })
    //
    .then(function() {
        return p;
    });
    // return w.runGit(path, params).then(
    // function(result) {
    // var txt = result.stdout.join('');
    // return splitter(txt);
    // })
}

function formatVersion(v) {
    return '[' + v.versionId + '] at ' + DateUtils.formatDate(v.timestamp)
            + ' by ' + v.author;
}

function showRepositoryHistory() {
    var counter = 1;
    fileStat.getAll().then(function(filesInfo) {
        _.each(filesInfo, function(info, path) {
            // if ('deleted' in info)
            // return;
            console.log((counter++) + ') ' + path);
            if (info.updated) {
                console.log(' updated: ' + formatVersion(info.updated));
            }
            if (info.created) {
                console.log(' created: ' + formatVersion(info.created));
            }
            if (info.deleted) {
                console.log(' deleted: ' + formatVersion(info.deleted));
            }
        })
    })
    return true;
}

Q()
// .then(removeRepository) //
.then(createRepository) // 
.then(updateRepositoryHistory) //
.then(updateRepository) //
.then(updateRepositoryHistory) //
.then(showRepositoryHistory) //
.then(function() {
    var fileName = 'README.txt';
    var params = [ 'log', '--', fileName ];
    return w.runGit(path, params).then(function(result) {
        var txt = result.stdout.join('');
        var commits = GitUtils.parseCommitMessages(txt);
        console.log('===================================');
        console.log('File history:')
        _.each(commits, function(commit) {
            console.log(formatVersion(commit));
            // console.log('-----------------------------------');
            // console.log(commit);
        });
        return true;
    });
}).done();

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// * Commit all newly created/modified files:
// > git add .
// > git commit -m 'Commit message'

// * Get last repository ID:
// > git rev-parse HEAD

// * Get a list of all files in a repository for a specific prefix:
// > git ls-files test/specs

// * Get the last commit info:
// > git log -1 --date=iso

// returns the following fields: 'commit', 'Author:', 'Date:' and after that -
// comment
// # commit 34488256c0d7ac0f0f0fd0e9cb68b09722631029
// # Author: kotelnikov <mikhail.kotelnikov@ubimix.com>
// # Date: 2013-09-21 16:54:26 +0200

// * Get the timestamp of the last commit:
// > git log -1 --date=iso

// * Get a list of changes
// > git log --stat --date=iso --since="2013-09-19 20:27:20 +0200"
// > git whatchanged --date=iso --since="2013-09-19 20:27:20 +0200"

//
// run('git', [ 'rev-parse', 'HEAD' ], {
// cwd : './tmp'
// }).then(function(result) {
// console.log(result.stdout.join());
// }).fail(function(err) {
// console.log(err)
//
// }).done();

