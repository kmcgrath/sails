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
      sails.mounts = sails.mounts || {};

      var loadMountableApp = function(pair,iterCb) {
        var mountPath = pair[0],
            mountOpts = pair[1];

        if (mountOpts.app !== undefined) {
          async.detect(
            [sails.config.appPath+'/node_modules/'+mountOpts.app,mountOpts.app],
            function(appPath,detectCb) {
              try {
                path.dirname(require.resolve(appPath));
                detectCb(true);
              }
              catch (err) {
                detectCb(false);
              }
            },
            function(result) {
              var mountApp = new Sails();
              sails.mounts[result] = mountApp;

              mountApp.parentApp = sails;
              mountApp.load({
                appPath: result,
                globals: false
              },function(){
              });

              // If controllers hook is enabled, also wait until controllers are known.
              var eventsToWaitFor = [];
              eventsToWaitFor.push('router:after');
              if (sails.hooks.policies) {
                      eventsToWaitFor.push('hook:policies:bound');
              }
              if (sails.hooks.orm) {
                      eventsToWaitFor.push('hook:orm:loaded');
              }
              if (sails.hooks.controllers) {
                      eventsToWaitFor.push('hook:controllers:loaded');
              }
              sails.after(eventsToWaitFor, function() {
                sails.mountsContainer.use(mountPath, mountApp.hooks.http.app);
              });

              iterCb();
            }
          );
        }
      };

      async.each(_.pairs(sails.config.mounts), loadMountableApp, function(err) {
        return cb();
      });

    }
  };
};

