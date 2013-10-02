'use strict'
var _ = require('underscore');
var Q = require('q');
var Path = require('path');
var ChildProcess = require('child_process');
var Fs = require('fs');
var utils = require('../git-utils');
var LRU = require('lru-cache');
var filestats = require('../git-filestats');

var DateUtils = utils.DateUtils;
var SysUtils = utils.SysUtils;
var GitUtils = utils.GitUtils;

var FileStats;
FileStats = filestats.SyncFileStats;
FileStats = filestats.AsyncFileStats;

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

function newCommitInfo() {
    var stamp = DateUtils.formatDate(new Date().getTime());
    var contentStamp = stamp;
    contentStamp = '';
    return {
        comment : 'A new commit ' + stamp,
        author : 'James Bond <james.bond@mi6.gov.uk>',
        files : {
            'README.txt' : 'Modified README content. ' + contentStamp,
            'foo/bar/toto.txt' : 'Foo-bar content',
            'test.txt' : 'A new test file'
        }
    }
}
function updateRepository() {
    var commit = newCommitInfo();
    return w.writeAndCommitRepository(path, commit);
}

function updateRepositoryHistory() {
    var params = [ 'whatchanged', '--date=iso' ];

    var range = [ 'f4d60c01f916beafd9c2743a5bc739bb90eda38e..38779907ad0d5ff6742511f760281e0240e6ea85' ];
    range = [ '5dc2f121542d814eeee2ae8d8101fabed07d31ed..3ae0843a133cbf13d8cc699c9d4e9271ea44b2ed' ];
    range = [ '--since="2013-09-19 20:27:20 +0200"' ];
    range = [ '--since="2013-09-20 00:00:00 +0200"' ]
    range = [ '--since="2013-09-20 00:00:00 +0200"',
            '--until="2013-09-20 12:00:00 +0200"' ]
    return w.runGitAndCollectCommits(path, params, function(commit) {
        var promises = Q();
        var version = {
            versionId : commit.versionId,
            timestamp : commit.timestamp,
            author : commit.author
        }
        var files = GitUtils.parseModifiedResources(commit.data);
        _.each(files, function(fileStatus, filePath) {
            promises = promises.then(function() {
                return fileStat.updateStatus(filePath, fileStatus, version);
            })
        })
        return promises;
    });

    // return w.runGit(path, params).then(
    // function(result) {
    // var txt = result.stdout.join('');
    // return splitter(txt);
    // })
}

function formatVersion(v) {
    var version = v.versionId;
    version = version.substring(0, 8);
    return '[' + version + '] at ' + DateUtils.formatDate(v.timestamp) + ' by '
            + v.author;
}

function showFileStatus(info) {
    console.log(info);
    if (info.updated) {
        console.log(' updated: ' + formatVersion(info.updated));
    }
    if (info.created) {
        console.log(' created: ' + formatVersion(info.created));
    }
    if (info.deleted) {
        console.log(' deleted: ' + formatVersion(info.deleted));
    }
}
function showRepositoryHistory() {
    var counter = 1;
    fileStat.getAll().then(function(filesInfo) {
        _.each(filesInfo, function(info, path) {
            // if ('deleted' in info)
            // return;
            console.log((counter++) + ') ' + path);
            showFileStatus(info);
        })
    })
    return true;
}

function showFileHistory() {
    var fileName = 'README.txt';
    var params = [ 'log', '--', fileName ];
    var counter = 1;
    console.log('===================================');
    console.log('File history "' + fileName + '":');
    return w.runGitAndCollectCommits(path, params, function(commit) {
        // console.log(' * ' + (counter++), commit);
        console.log(' * ' + (counter++), formatVersion(commit));
    });
}

Q()
// // .then(removeRepository) //
.then(createRepository) //
.then(updateRepositoryHistory) //
.then(updateRepository) //
.then(updateRepositoryHistory) //
.then(
        function() {
            var file = 'README.txt';
            var versionId = 'HEAD';
            // versionId = 'aac65894';
            // versionId = 'a4731a13'
            return w.readFromRepository(path, file, versionId).then(
                    function(contentList) {
                        console.log('File content for "' + file + '" (version:'
                                + versionId + '):');
                        console.log('~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
                        console.log(contentList);
                        console.log('~~~~~~~~~~~~~~~~~~~~~~~~~~~~');
                        return true;
                    })
            return true;
        }).then(showRepositoryHistory) //
.then(showFileHistory) //
.then(
        function() {
            return fileStat.getStat('README.txt', 'foo/bar/toto.txt').then(
                    function(stats) {
                        console.log('===================================');
                        console.log('File status:');
                        _.each(stats, function(stat, path) {
                            console.log('-----------------------------------');
                            console.log(' * ' + path + ':')
                            showFileStatus(stat);
                        })
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

