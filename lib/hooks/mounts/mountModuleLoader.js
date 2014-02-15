module.exports = function(sails) {


	/**
	 * Module dependencies
	 */

	var buildDictionary = require('sails-build-dictionary'),
		async = require('async'),
    util = require('sails-util'),
    originalModuleLoader = require('../moduleloader')
;

  // var orig = originalModuleLoader(sails);
  var orig = originalModuleLoader(sails);
	return {

		loadModels: function (cb) {
      orig.loadModels(function(err, dict) {
        var cDict = util.cloneDeep(dict);
        util.each(util.values(cDict), function(mDict) {
          if (mDict.identity) {
            mDict.identity = sails.mountName+':'+mDict.identity;
            mDict.globalId = sails.mountName+':'+mDict.globalId;
          }
        });
        cb(err, cDict);
      });
		},

    loadUserConfig: function(cb) {
      orig.loadUserConfig(function(err, config) {

        if (config.models.connection)
          config.models.connection = sails.mountName+':'+config.models.connection;

        util.each(util.keys(config.connections), function(connName) {
          config.connections[sails.mountName+':'+connName] = config.connections[connName];
          delete config.connections[connName];
        });

        cb(err,config);
      });
    }

  };
};
