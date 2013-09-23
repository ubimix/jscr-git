if (typeof define !== 'function') {
    var define = require('amdefine')(module)
}
define([ 'underscore', 'q' ], function(_, Q) {

    function FileStatStore() {
        this.index = {};
    }
    _.extend(FileStatStore.prototype, {
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
                if (!info.updated
                        || (info.updated.timestamp < version.timestamp)) {
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
        getStat : function() {
            var results = {};
            _.each(_.toArray(arguments), function(path) {
                results[path] = this.index[path];  
            }, this);
            return Q(results);
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
    }
    _.extend(AsyncFileStats.prototype, AbstractFileStats.prototype);
    _.extend(AsyncFileStats.prototype, {

        getFilestatStore : function() {
            if (this.store == null) {
                this.store = new FileStatStore();
            }
            return this.store;
        },
        getAll : function() {
            var store = this.getFilestatStore();
            return store.getAll();
        },
        getStat : function(path) {
            var paths = _.toArray(arguments);
            var store = this.getFilestatStore();
            return store.get.apply(store, paths);
        },
        updateStatus : function(path, status, version) {
            var that = this;
            var store = that.getFilestatStore();
            return store.get(path).then(function(result) {
                var info = result[path];
                if (!info) {
                    info = {};
                }
                var result = that._doUpdateInfo(info, status, version);
                return store.put(path, info);
            });
        }
    });

    return {
        FileStatStore : FileStatStore,
        AbstractFileStats : AbstractFileStats,
        SyncFileStats : SyncFileStats,
        AsyncFileStats : AsyncFileStats
    }
});
