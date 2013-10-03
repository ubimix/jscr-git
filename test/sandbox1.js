'use strict'
var _ = require('underscore');
var Q = require('q');
var JSCR = require('../jscr-git');
var SysUtils = require('../git-utils').SysUtils;

var rootDir = './tmp';

function clearRootDir() {
    return SysUtils.remove(rootDir);
}
var connection = new JSCR.Implementation.Git.WorkspaceConnection({
    rootDir : rootDir
});

var commitCounter = 0;
function saveAndCheckResource(project, fileName, properties) {
    return project.loadResource(fileName, {
        create : true
    }).then(function(resource) {
        var props = resource.getProperties();
        _.each(properties, function(val, key) {
            props[key] = val;
        });
        return project.storeResource(resource, {
            commit : 'commit message ' + (++commitCounter),
            author : 'it is me <foo.bar>'
        });
    }).then(function() {
        return project.loadResource(fileName).then(function(resource) {
            var props = resource.getProperties();
            _.each(properties, function(val, key) {
                var test = props[key];
                if (test != val) {
                    var msg = 'Key: "' + key + '". ';
                    msg += 'Expected: "' + val + '". ';
                    msg += 'Real: "' + test + '".';
                    throw new Error(msg);
                }
            })
            return resource;
        })
    });
}
var projectName = 'myproject';
var project = null;
var dataCounter = 1;

// 
var promise = Q()
// Clear the test project folder
.then(clearRootDir)
// Connect to the workspace
.then(function() {
    return connection.connect();
})
// Create a project
.then(function(workspace) {
    return workspace.loadProject(projectName, {
        create : true
    });
})
// Set the project in an internal variable
.then(function(prj) {
    project = prj;
    return prj;
})
// Creates and check a new resource
.then(function() {
    var promise = Q();
    var count = 10;
    for ( var i = 0; i < count; i++) {
        promise = promise.then(function() {
            var idx = dataCounter++;
            return saveAndCheckResource(project, 'abc/hello.toto', {
                label : 'I am a label ' + idx,
                content : 'This is a content ' + idx
            });
        });
    }
    return promise;
})
// Loads and check the resource history
.then(
        function() {
            console.log('---------------------------------------------------')
            return project.loadResourceHistory('abc/hello.toto').then(
                    function(history) {
                        return project.loadResourceRevisions('abc/hello.toto',
                                {
                                    versions : history
                                });
                    });
        })

// Show all loaded revisions
.then(function(revisions) {
    _.each(revisions, function(revision) {
        console.log('* Revision : ' , revision)
    })
    return true;
})
// Finalize all operations and report about exceptions
.done();
