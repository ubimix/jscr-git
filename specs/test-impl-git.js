"use strict"

require.config({
    paths : {
        'jscr-git' : '../'
    }
});

var Q = require('q');
var _ = require('underscore');
var JSCR = require('jscr-api/jscr-api');
require('jscr-git/jscr-git');
var TestUtils = require('jscr-api/test-utils');
var SysUtils = require('jscr-git/git-utils').SysUtils;

var tests = [ 'jscr-api/test-workspace-connection', 'jscr-api/test-workspace',
        'jscr-api/test-project' ];
// var tests = [ 'jscr-api/test-workspace' ];

var specs = _.map(tests, function(test) {
    return require(test);
})

var rootDir = './tmp';
function newConnection() {
    return new JSCR.Implementation.Git.WorkspaceConnection({
        rootDir : rootDir
    });
}

var promise = Q();
_.each(specs, function(spec) {
    promise = promise.then(function() {
        return SysUtils.remove(rootDir).then(function() {
            spec(newConnection);
        }).fail(function(err) {
            console.log(err);
        })
    });
});
promise.done();

TestUtils.testPromise(promise);
