var FS = require('fs');
var Path = require('path');
var requirejs = require('requirejs');
var _ = require('underscore');

var workDir = process.cwd();
process.chdir(workDir);

var baseDir = __dirname;

var jasmineDir = Path.join(baseDir, 'libs/jasmine');
var Jasmine = require(Path.join(jasmineDir, '/lib/jasmine-core/jasmine'));
global.jasmine = Jasmine;
var jasmineMethods = [ 'describe', 'it', 'expect', 'waitsFor', 'beforeEach',
        'afterEach' ];
_.each(jasmineMethods, function(method) {
    global[method] = Jasmine[method];
    // console.log('* ' + method + ':', Jasmine[method])
})
require(Path.join(jasmineDir, '/src/console/ConsoleReporter'));

var specsDir = Path.resolve(workDir, process.argv[2] || 'specs');

// configure requirejs
requirejs.config({
    nodeRequire : require,
    baseUrl : specsDir
});

global.define = requirejs;
global.require = requirejs;

// load specs
var specs = [];
_.each(FS.readdirSync(specsDir), function(spec) {
    if (spec.indexOf('test-') >= 0) {
        var specFile = Path.join(specsDir, spec);
        specs.push(specFile);
    }
});

var jasmineEnv = Jasmine.jasmine.getEnv();
global.jasmineEnv = jasmineEnv;
jasmineEnv.addReporter(new Jasmine.ConsoleReporter(print, function() {
    print('\n');
}), true);
function print(msg) {
    process.stdout.write(msg);
}

// ????????
describe('Init', function() {
    it('', function() {
    });
});
// ????????

var finished = false;
requirejs(specs, function() {
    var promise = require('q')();
    var array = _.map(_.toArray(arguments), function(spec) {
        promise = promise.then(function() {
            return spec || true;
        });
    });
    promise.fin(function() {
        jasmineEnv.execute();
    })
    finished = true;
});
global.jasmine.waitsFor(function() {
    return finished;
}, "Operations should be finished in the 5000ms", 5000);
