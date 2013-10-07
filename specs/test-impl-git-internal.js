'use strict'

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

var rootDir = './tmp';
function newConnection() {
    return new JSCR.Implementation.Git.WorkspaceConnection({
        rootDir : rootDir
    });
}
function clearRootDir() {
    return SysUtils.remove(rootDir);
}

testContentUtils();
testProjectImpl();

function testContentUtils() {

    describe('Serialization/deserialization utils', function() {
        var ContentUtils = JSCR.Implementation.Git.ContentUtils;
        var resource = JSCR.resource();
        var props = resource.getProperties();
        props.a = 'A';
        props.b = 'B';
        props.description = 'Hello, world';
        var abc = resource.getPropertyFamily('abc', true);
        abc.one = '1';
        abc.two = '2';
        abc.three = '3';
        var str = ContentUtils.serializeResource(resource);
        var test = JSCR.resource();
        ContentUtils.deserializeResource(str, test);
        expect(test).toEqual(resource);
    });

    describe('Git path utils', function() {
        var ContentUtils = JSCR.Implementation.Git.ContentUtils;
        var indexFileName = 'index.txt';
        function testFileToResource(path, control) {
            var result = ContentUtils.toResourcePath(path, indexFileName);
            expect(result).toEqual(control);
        }
        function testResourceToFile(path, control) {
            var result = ContentUtils.toFilePath(path, indexFileName);
            expect(result).toEqual(control);
        }

        it('should be able to transform '
                + 'a logical resource path to a physical path to a file',
                function() {
                    testResourceToFile('', 'index.txt');
                    testResourceToFile('/', 'index.txt');
                    testResourceToFile('/abc', 'abc/index.txt');
                    testResourceToFile('/abc/index.txt', 'abc/index.txt');

                    testResourceToFile('toto.pdf', 'toto.pdf');
                    testResourceToFile('/abc/foo.bar.txt', 'abc/foo.bar.txt');
                });

        it('should be able to transform '
                + 'a logical physical path to a file to logical resource path',
                function() {
                    testFileToResource('/index.txt', '');
                    testFileToResource('/abc', 'abc');
                    testFileToResource('abc/index.txt', 'abc');
                    testFileToResource('/abc/index.txt', 'abc');

                    testFileToResource('toto.pdf', 'toto.pdf');
                    testFileToResource('/abc/foo.bar.txt', 'abc/foo.bar.txt');

                });
    })
}

function testProjectImpl() {
    describe('Git.Connection.Project', function() {
        var projectName = "test";
        var project;
        var promise;

        var testPromise = null;

        beforeEach(function() {
            testPromise = new TestUtils.TestPromise();
            promise = clearRootDir();
            promise = promise.then(function() {
                return newConnection().connect();
            }).then(function(workspace) {
                return workspace.loadProject(projectName, {
                    create : true
                });
            }).then(function(prj) {
                project = prj;
                return prj;
            });
        });
        afterEach(function() {
            testPromise.waitsForFinish();
            testPromise = null;
        })

        function showStat() {
            return project._loadResourceStats().then(function(fileStats) {
                // console.log(JSON.stringify(fileStats));
                return fileStats;
            })
        }
        // testCustomFile();
        testDefaultResource();

        function testDefaultResource() {
            it('should be able to write and read resources'
                    + ' with default index files', function() {
                var fileNames = [ 'a', 'a/b.txt', 'a/c.txt' ];
                promise = promise.then(function() {
                    return project.loadResources(fileNames, {
                        create : true
                    })
                });
                promise = promise.then(function(resources) {
                    _.each(fileNames, function(fileName) {
                        var resource = resources[fileName];
                        expect(resource).not.toEqual(null);
                        var path = resource.getPath();
                        expect(path).toEqual(fileName);
                    })
                    return true;
                });
                testPromise.test(promise);
            });
        }

        function testCustomFile() {
            it('should be able to write and read resources', function() {
                var fileName = 'foo/bar/Toto.txt';
                var statSize = 0;
                testPromise.test(promise.then(function() {
                    expect(project).not.toEqual(null);
                    return promise // 
                    .then(showStat)//
                    .then(function() {
                        return project._loadResourceStats()//
                        .then(function(fileStats) {
                            return fileStats.getAll() //
                            .then(function(filesInfo) {
                                statSize = _.size(filesInfo);
                                return filesInfo;
                            })
                        });
                    })
                    // Add a file in a raw format
                    .then(
                            function() {
                                var files = {};
                                files[fileName] = 'This is my profile.'
                                        + '\n-----\n' + 'firstName: John'
                                        + '\nlastName: Smith'
                                        + '\ntags: [dev, test, blog]';
                                return project._saveFiles({
                                    comment : 'New comment',
                                    author : 'John Smith <john.smith@foo.bar>',
                                    files : files
                                })
                            })

                    .then(showStat) //
                    .then(function() {
                        return project._loadResourceStats() //
                        .then(function(fileStats) {
                            return fileStats.getAll().then(function(filesInfo) {
                                var size = _.size(filesInfo);
                                expect(size).toEqual(statSize + 1);
                                return filesInfo;
                            })
                        });
                    }) //
                    .then(function() {
                        return project.loadResource(fileName) //
                        .then(function(resource) {
                            // console.log(JSON.stringify(resource,
                            // null, 2));
                            return true;
                        });
                    })
                }));
            });
        }

        it('should be able to return child resources', function() {
            var names = [ 'a', 'a/b', 'a/d/c.txt', 'a/b/c', 'a/n.txt' ]
            testPromise.test(promise.then(function() {
                return project.loadResources(names, {
                    create : true,
                    author : 'John Smith <john.smith@foo.bar>'
                }).then(function(resources) {
                    // var a = resources['a'];
                    // expect(a).not.toEqual(null);
                    return project.loadChildResources('a').then(function(test) {
                        // console.log('Resources:', JSON.stringify(test, null,
                        // 2))
                        return true;
                    });
                    return 1
                })
            }));
        });

    })
}
