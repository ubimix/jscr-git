"use strict"
if (typeof define !== 'function') {
    if (require) {
        var define = require('amdefine')(module)
    } else {
        var define = function(dep, f) {
            this.StringEncoder = f();
        }
    }
}
define([], function() {

    function StringEncoder(escapeSymbol) {
        this.escapeSymbol = escapeSymbol || '_';
        this.escapeCode = this.escapeSymbol.charCodeAt(0);
    }

    StringEncoder.prototype.decode = function(str) {
        if (!str)
            return '';
        var buf = '';
        var ch = 0;
        var chPos = 0;
        var chLen = 1;
        for ( var i = 0; i < str.length; i++) {
            var currentByte = str.charCodeAt(i);
            if (currentByte == this.escapeCode) {
                if (i < str.length - 2) {
                    var s = str.substring(i + 1, i + 3);
                    var code = parseInt(s, 16);
                    i += 2;
                    if (chPos == 0) {
                        if (code >= 0x00 && code <= 0x7F) {
                            chLen = 1;
                            code &= (0xFF >>> 1);
                        } else if (code >= 0xC2 && code <= 0xDF) {
                            chLen = 2;
                            code &= (0xFF >>> 3);
                        } else if (code >= 0xE0 && code <= 0xEF) {
                            chLen = 3;
                            code &= (0xFF >>> 4);
                        } else if (code >= 0xF0 && code <= 0xF4) {
                            chLen = 4;
                            code &= (0xFF >>> 5);
                        }
                    } else {
                        code &= (0xFF >>> 2);
                    }
                    if (chPos == chLen - 1) {
                        ch |= code;
                    } else if (chPos == chLen - 2) {
                        ch |= code << 6;
                    } else if (chPos == chLen - 3) {
                        ch |= code << 12;
                    }
                }
            } else {
                ch = currentByte;
                chLen = 1;
            }
            chPos++;
            if (chPos >= chLen) {
                buf += String.fromCharCode(ch);
                ch = 0;
                chPos = 0;
            }
        }
        return buf;
    }

    StringEncoder.prototype._appendEscaped = function(buf, chCode) {
        var str = chCode.toString(16);
        str = str.toUpperCase();
        buf += this.escapeSymbol;
        buf += str;
        return buf;
    }

    StringEncoder.prototype._isValid = function(ch, pos) {
        // return ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')
        // || (pos > 0 && ch >= '0' && ch <= '9') || ch == '-');
        if (ch == this.escapeSymbol)
            return false;
        return ch.match(/[\d\w-]/);
    }

    StringEncoder.prototype.encode = function(str) {
        if (!str || str == '')
            return '';
        var buf = '';
        for ( var i = 0; i < str.length; i++) {
            var ch = str.charAt(i);
            var chCode = ch.charCodeAt(0);
            if (this._isValid(ch, i)) {
                buf += ch;
            } else if (chCode < 128) {
                buf = this._appendEscaped(buf, chCode);
            } else if ((chCode > 127) && (chCode < 2048)) {
                buf = this._appendEscaped(buf, (chCode >>> 6) | 192);
                buf = this._appendEscaped(buf, (chCode & 63) | 128);
            } else {
                buf = this._appendEscaped(buf, (chCode >>> 12) | 224);
                buf = this._appendEscaped(buf, ((chCode >>> 6) & 63) | 128);
                buf = this._appendEscaped(buf, (chCode & 63) | 128);
            }
        }
        return buf;
    }

    return StringEncoder;
});
