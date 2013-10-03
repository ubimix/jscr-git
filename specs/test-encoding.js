var StringEncoder = require('../string-encoder');
describe(
        'String serialization/deserialization ',
        function() {
            it(
                    'should be able to encode and decode a string '
                            + 'without loosing information',
                    function() {
                        test("");
                        test(" ");
                        test("_");
                        test("abc");
                        test("\"'-é:");
                        test("|");
                        test("123abc");
                        test("мама мыла раму");
                        test("http://opensocial-resources.googlecode.com/svn/spec/trunk/Core-Data.xml#Local-Id");
                    });
        });

function test(str) {
    var encoder = new StringEncoder('_');
    var encoded = encoder.encode(str);
    var test = encoder.decode(encoded);
    // console.log('* ', str, ' ', encoded, ' ', test);
    expect(test).toEqual(str);
}
