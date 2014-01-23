/**
* Public dependencies.
*/

var _ = require('lodash'),
util = require('sails-util'),
async = require('async'),
path = require('path'),
fs = require('fs'),
Sails = require('../../app');


/**
* Expose `controllers` hook definition
*/
module.exports = function(sails) {

  return {

    defaults: {},

    // Don't allow sails to lift until ready 
    // is explicitly set below
    ready: false,


    /**
    * Initialize is fired first thing when the hook is loaded
    *
    * @api public
    */

    initialize: function(cb) {

      // Load mounts from from configuration as middleware.
      this.loadAndRegisterMountableApps(cb);

    },


    /**
    * Wipe everything and (re)load middleware from controllers
    *
    * @api private
    */

    loadAndRegisterMountableApps: function(cb) {
      var self = this;

      // Ensure clean mounts dictionary
      sails.mounts = sails.mounts || {};

      // Iteration function to pass to async.each for finding and loading
      // sub applictions from sails.config
      var loadMountableApp = function(pair,iterCb) {
        var mountPath = pair[0],
            mountOpts = pair[1];

        if (mountOpts.app !== undefined) {
          async.detect(

            // Try node_modules in appPath first then general require()
            [sails.config.appPath+'/node_modules/'+mountOpts.app,mountOpts.app],

            // Attempt load for each path
            function(appPath,detectCb) {
              try {
                path.dirname(require.resolve(appPath));
                detectCb(true);
              }
              catch (err) {
                detectCb(false);
              }
            },

            // First path that exists is used to load the app
            function(pathResult) {
              var mountApp = new Sails();
              sails.mounts[mountPath] = mountApp;

              mountApp.parentApp = sails;
              mountApp.load({
                appPath: pathResult,
                globals: false
              },function(){});

              var loadApp = function(req,res) {
                mountApp.hooks.http.app(req,res);
              };

              self.middleware[mountPath] = loadApp;
              sails.emit("mounts:mount", loadApp);
              //sails.mountsContainer.use(mountPath, loadApp);

              // iterCb();
            }
          );
        }
      };

      //// Load each mount defined in the config
      //async.each(_.pairs(sails.config.mounts), loadMountableApp, function(err) {
        ////TODO catch and handle errors
        //return cb();
      //});

      // Load each mount defined in the config
      util.each(_.pairs(sails.config.mounts), loadMountableApp);
      return cb();

    }
  };
};

