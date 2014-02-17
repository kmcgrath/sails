/**
* Public dependencies.
*/

var _ = require('lodash'),
util = require('sails-util'),
async = require('async'),
path = require('path'),
fs = require('fs'),
Sails = require('../../app'),
express= require('express'),
moduleLoader = require('./mountModuleLoader');


/**
* Expose `controllers` hook definition
*/
module.exports = function(sails) {

  return {

    defaults: {
      hooks: {
        grunt: false,
        csrf: false,
        log: false
      },
      moduleLoaderOverride: moduleLoader,
      globals: false
    },

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
        var mountName = pair[0],
            mountOpts = pair[1];

        var mountPath = mountOpts['path'] || '/'+mountName;

        if (mountOpts.app !== undefined) {
          var findPath = util.detect(
            // Try node_modules in appPath first then general require()
            [sails.config.appPath+'/node_modules/'+mountOpts.app,mountOpts.app],

            // Attempt load for each path
            function(appPath,detectCb) {
              try {
                path.dirname(require.resolve(appPath));
                return true;
              }
              catch (err) {
                return false;
              }
            }
          );

          if (findPath) {
            var mountApp = new Sails();
            sails.mounts[mountName] = mountApp;

            mountApp.parentApp = sails;
            mountApp.mountName = mountName;
            mountApp.log = sails.log;

            mountApp.load(
              util.merge(self.defaults,{
                         appPath: findPath
              }),function(){ }
            );

            mountApp.on("router:bind", function(route) {
              var path = (mountPath + route.path).replace(/\/$/,"");
              sails.router.bind(path, route.target, route.verb);
            });

            self.middleware[mountPath] = {
              mountPath: mountPath,
              mount: function (req,res,next) {
                mountApp.hooks.http.app(req,res,next);
              }
            };
          }
        }
      };

      // Load each mount defined in the config
      util.each(_.pairs(sails.config.mounts), loadMountableApp);
      return cb();

    }
  };
};

