/**
 * Module dependencies.
 */

var _ = require('lodash'),
	async = require('async'),
	Err = require('../../../errors'),
	Waterline = require('waterline'),
	fs = require('fs');
	



module.exports = function(sails) {



	var loadAppModelsAndAdapters = require('./loadUserModules')(sails);


	/**
	 * Expose Hook definition
	 */

	return {

		defaults: {

			globals: {
				adapters: true,
				models: true
			},

			// Default model properties
			models: {
				
				// This default connection (i.e. datasource) for the app
				// will be used for each model by unless otherwise specified.
				// connection: 'localDiskDb'
			},


			// Connections to data sources, web services, and external APIs.
			// Can be attached to models and/or accessed directly.
			connections: {

				// Built-in disk persistence
				// (defaults to .tmp/disk.db)
				// localDiskDb: { adapter: 'sails-disk' }
			}
		},

		configure: function () {

			var self = this;

			//////////////////////////////////////////////////////////////////////////////////////////
			// Backwards compat. for `config.adapters`
			//////////////////////////////////////////////////////////////////////////////////////////

			// `sails.config.adapters` is now `config.connections`
			if (sails.config.adapters) {

				// `config.adapters.default` is being replaced with `config.models.connection`
				if (sails.config.adapters['default']) {
					sails.log.warn('Deprecation warning :: Trying to replace `config.adapters.default` with `config.models.connection`....');
					sails.config.models.connection = sails.config.models.connection || sails.config.adapters['default'];
				}
				
				// Merge `config.adapters` into `config.connections`
				sails.log.warn('Deprecation warning :: Replacing `config.adapters` with `config.connections`....');
				_.each(sails.config.adapters, function (legacyAdapterConfig, connectionName) {
					// Ignore `default`
					if (connectionName === 'default') {
						return;
					}

					// Normalize `module` to `adapter`
					var connection = _.clone(legacyAdapterConfig);
					connection.adapter = connection.module;
					delete connection.module;
					sails.log.warn(
						'Deprecation warning :: ' +
						'Replacing `config.adapters['+connectionName+'].module` ' + 
						'with `config.connections['+connectionName+'].adapter`....');
					sails.config.connections[connectionName] = sails.config.connections[connectionName] = connection;
				});
				delete sails.config.adapters;
			}



			// Listen for reload events, which will just run the initialize over again
			sails.on('hook:orm:reload', function() {
				self.initialize(function(err) {
					// If the re-initialization was a success, trigger an event
					// in case something needs to respond to the ORM reload (e.g. pubsub)
					if (!err) {
						sails.emit('hook:orm:reloaded');
					}
				});
			});

		},

		initialize: function(cb) {
			var self = this;

			////////////////////////////////////////////////////////////////////////////
			// NOTE: If a user hook needs to add or modify model definitions,
			// the hook should wait until `hook:orm:loaded`, then reload the original 
			// model modules `orm/loadUserModules`. Finally, the ORM should be flushed using
			// `restart()` below.
			////////////////////////////////////////////////////////////////////////////


			// Load model and adapter definitions defined in the project
			async.auto({
				
				_loadModules: loadAppModelsAndAdapters,

				// Normalize model definitions and merge in defaults from `sails.config.models`
				modelDefs: ['_loadModules', function normalizeModelDefs (cb) {
					_.each(sails.models, self.normalizeModelDef);
					cb(null, sails.models);
				}],

				// Once all user model definitions are loaded into sails.models, 
				// go ahead and start the ORM, instantiate the models
				instantiatedCollections: ['modelDefs', this.startORM],


				_exposeModels: ['instantiatedCollections', this.exposeModels]

			}, cb);
		},



		/**
		 * Merge defaults and normalize options in this model definition
		 */
		normalizeModelDef: function (modelDef, modelID) {

			// Implicit framework defaults
			var implicitDefaults = {
				identity: modelID,
				tableName: modelID
			};

			// App defaults from `sails.config.models`
			var appDefaults = sails.config.models;
			
			// Rebuild model definition using the defaults
			modelDef = _.merge(implicitDefaults, appDefaults, modelDef);


			// Backwards compatibilty for `Model.adapter`
			if (modelDef.adapter) {
				sails.log.verbose(
					'Deprecation warning :: ' + 
					'Replacing `' + modelDef.globalId + '.adapter` ' +
					'with `' + modelDef.globalId + '.connection`....');
				modelDef.connection = modelDef.adapter;
				delete modelDef.adapter;
			}

			// If no connection can be determined (even by using app-level defaults [config.models])
			// throw a fatal error.
			if ( !modelDef.connection ) {
				return Err.fatal.__ModelIsMissingConnection__(modelDef.globalId);
			}

			// Coerce `Model.connection` to an array
			if ( ! _.isArray(modelDef.connection) ) {
				modelDef.connection = [modelDef.connection];
			}


			// ======================================================================== 
			// ======================================================================== 
			// ======================================================================== 
			//
			// Below, we should replace with new stuff in Waterline v0.10:
			// 

			// Iterate through each of this models' connection
			// -> If `connection` is not an object yet, try to look-up connection by name
			// -> Otherwise `connection` defined inline in model-- just need to normalize it
			// -> If invalid connection found, throw fatal error.
			modelDef.connection = _.map( modelDef.connection, function (connection) {
				if ( _.isString(connection) ) {
					connection = _lookupConnection(connection, modelID);
					connection = _normalizeConnection(connection, modelID);
					return connection;
				}
				if ( _.isObject(connection) ) {
					return _normalizeConnection(connection, modelID);
				}
				return Err.fatal.__InvalidConnection__ (connection, modelDef.identity);
			});

			// If it isn't set directly, set the model's `schema` property 
			// based on the first adapter in its connections (left -> right)
			if ( typeof modelDef.schema === 'undefined') {
				var connection, schema;
				for (var i in modelDef.connection) {
					connection = modelDef.connection[i];
					// console.log('checking connection: ', connection);
					if (typeof connection.schema !== 'undefined') {
						schema = connection.schema;
						break;
					}
				}
				// console.log('trying to determine preference for schema setting..', modelDef.schema, typeof modelDef.schema, typeof modelDef.schema !== 'undefined', schema);
				if (typeof schema !== 'undefined') {
					modelDef.schema = schema;
				}
			}

			// Save modified model definition back to sails.models
			sails.models[modelID] = modelDef;


			//
			// ========================================================================
			// ========================================================================
			// ========================================================================


		},



		/**
		 * Instantiate Waterline Collection for each Sails Model,
		 * then start the ORM.
		 *
		 * @param {Function}	cb
		 *						  -> err	// Error, if one occurred, or null
		 *
		 * @param {Object}		stack
		 *						stack.modelDefs {}
		 *
		 * @global {Object}		sails
		 *						sails.models {}
		 */
		startORM: function(cb, stack) {
			var modelDefs = stack.modelDefs;

			// -> Build adHoc adapters (this will add `adapter` key to models)
			//		(necessary for loading the right adapter config w/i Waterline)
			var adHocAdapters = _buildAdHocAdapterSet(modelDefs);
			sails.adHocAdapters = adHocAdapters;

			// -> Instantiate ORM in memory.
			// -> Iterate through each model definition:
			//		-> Create a proper Waterline Collection for each model
			//		-> then register it w/ the ORM.
			sails.log.verbose('Starting ORM...');
			var waterline = new Waterline();
			_.each(modelDefs, function loadModelsIntoWaterline (modelDef, modelID) {
				sails.log.silly('Registering model `' + modelID + '` in Waterline (ORM)');
				waterline.loadCollection( Waterline.Collection.extend(modelDef) );
			});


			// -> "Initialize" ORM
			// 		: This performs tasks like managing the schema across associations,
			//		: hooking up models to their connections, and auto-migrations.
			waterline.initialize({
				
				// Build `adHocAdapters`
				// The set of working adapters waterline will use internally
				// Adapters should be built using the proper adapter definition with config
				// from the source connection mixed-in
				adapters: adHocAdapters
			}, cb);
		},


		/**
		 * exposeModels
		 * 
		 * @param {Function}	cb
		 *						  -> err	// Error, if one occurred, or null
		 *
		 * @param {Object}		stack
		 *						stack.instantiatedCollections {}
		 */
		exposeModels: function (cb, stack) {
			var collections = stack.instantiatedCollections;

			Object.keys(collections).forEach(function eachInstantiatedCollection (modelID) {

				// Bind context for models
				// (this (breaks?)allows usage with tools like `async`)
				_.bindAll(collections[modelID]);

				// Derive information about this model's associations from its schema
				var associatedWith = [];
				_(collections[modelID].attributes).forEach(function buildSubsetOfAssociations(attrDef, attrName) {
					if (typeof attrDef === 'object' && (attrDef.model || attrDef.collection)) {
						associatedWith.push(_.merge({
							alias: attrName,
							type: attrDef.model ? 'model' : 'collection'
						}, attrDef));
					}
				});

				// Expose `Model.associations` (an array)
				collections[modelID].associations = associatedWith;


				// Set `sails.models.*` reference to instantiated Collection
				// Exposed as `sails.models[modelID]`
				sails.models[modelID] = collections[modelID];

				// Create global variable for this model
				// (if enabled in `sails.config.globals`)
				// Exposed as `[globalId]`
				if (sails.config.globals && sails.config.globals.models) {
					var globalName = sails.models[modelID].globalId || sails.models[modelID].identity;
					global[globalName] = collections[modelID];
				}
			});

			cb();
		}
	};



	/**
	 * Lookup a connection (e.g., `{ adapter: 'sails-disk' }`)
	 * by name (e.g., 'devDB')
	 *
	 * @param {String}	connectionName
	 *
	 * @param {String}	modelID
	 *					// Optional, improves quality of error messages
	 *
	 * @global	sails
	 *			sails.config
	 *			sails.config.connections {}
	 *
	 * @throws {Err.fatal}	__UnknownConnection__
	 * @api private
	 */
	function _lookupConnection (connectionName, modelID) {
		var connection = sails.config.connections[connectionName];

		// If this is not a known connection, throw a fatal error.
		if (!connection) {
			return Err.fatal.__UnknownConnection__ (connectionName, modelID);
		}
		return connection;
	}



	/**
	 * Normalize properties of a connection
	 * (handles deprecation warnings / validation errors and making types consistent)
	 *
	 * @param {Object}	connection
	 *					connection.adapter	// Name of adapter module used by this connection
	 *					connection.module	// Deprecated- equivalent to `connection.adapter`
	 *
	 * @param {String}	modelID
	 *					// Optional, improves quality of error messages
	 *					// Identity of the model this connection came from
	 *
	 * @throws {Err.fatal}		__UnknownConnection__
	 * @throws {Err.fatal}		__InvalidConnection__
	 * @throws {Err.fatal}		__InvalidAdapter__
	 * @api private
	 */
	function _normalizeConnection (connection, modelID) {
		// Connection is not formatted properly, throw a fatal error.
		if ( !_.isObject(connection) ) {
			return Err.fatal.__InvalidConnection__ (connection, modelID);
		}

		// Backwards compatibilty for `connection.module`
		if ( connection.module ) {
			sails.log.verbose(
				'Deprecation warning :: In model `' + modelID + '`\'s `connection` config, ' + 
				'replacing `module` with `adapter`....');
			connection.adapter = connection.module;
			delete connection.module;
		}

		// Adapter is required for a connection
		if ( !connection.adapter ) {
			// Invalid connection found, throw fatal error.
			return Err.fatal.__InvalidConnection__ (connection, modelID);
		}

		// Verify that referenced adapter has been loaded
		// If it doesn't, try and load it as a dependency from `node_modules`
		if (!sails.adapters[connection.adapter]) {

			// (Format adapter name to make sure we make the best attempt we can)
			var moduleName = connection.adapter;
			if ( ! moduleName.match(/^(sails-|waterline-)/) ) {
				moduleName = 'sails-' + moduleName;
			}

			// Since it is unknown so far, try and load the adapter from `node_modules`
			sails.log.verbose('Loading adapter (', moduleName, ') for ' + modelID, ' from `node_modules` directory...');

			var modulePath = _findConnection(sails, connection, moduleName);
			if ( !fs.existsSync (modulePath) ) {
				// If adapter doesn't exist, log an error and exit
				return Err.fatal.__UnknownAdapter__ (connection.adapter, modelID, sails.majorVersion, sails.minorVersion);
			}

			// Since the module seems to exist, try to require it (execute the code)
			try {
				sails.adapters[moduleName] = require(modulePath);
			}
			catch (err) {
				return Err.fatal.__InvalidAdapter__ (moduleName, err);
			}
		}

		// Defaults connection object to its adapter's defaults
		var desAdapters = sails.adapters[connection.adapter];
		connection = _.merge({}, desAdapters.defaults, connection);

		// Success- connection normalized and validated
		// (any missing adapters were either acquired, or the loading process was stopped w/ a fatal error)
		return connection;
	}

  function _findConnection(app, connection, moduleName) {
	  var modulePath = app.config.appPath + '/node_modules/' + moduleName;
    if ( !fs.existsSync (modulePath) ) {
      if (app.parentApp !== undefined) {
        return _findConnection(app.parentApp, connection, moduleName);
      }
      else {
        // If adapter doesn't exist, log an error and exit
        return null; // Err.fatal.__UnknownAdapter__ (connection.adapter, modelID, sails.majorVersion, sails.minorVersion);
      }
    }
    else {
      return modulePath;
    }
  }



	/**
	 * buildAdHocAdapterSet
	 *
	 * The `ad hoc adapter set` consists of the working adapters Waterline uses internally
	 * to talk to various resources.  In this function, ad hoc adapters are built from the connection configuration 
	 * in the provided models.  For each unique connection, a new ad-hoc adapter is built, and `registerCollection()` 
	 * will be run.
	 *
	 * Note	: `Model.connection` must already be cross-referenced against `sails.config.connections` at this point,
	 *		: since we assume that in every case, `Model.connection` is an array of objects with an `adapter` property.
	 *
	 * @sideEffect modifies `modelDefinitions` (adds `adapter` key)
	 *
	 * @param {Object} modelDefinitions
	 *
	 * TODO :	Perhaps instead of creating clones (ad-hoc adapters), extend Waterline to figure out connection objects
	 *			internally, so then they can just be passed in.
	 *			e.g., `modelDef.adapter = _.cloneDeep(modelDef.connection);`
	 */
	function _buildAdHocAdapterSet (modelDefinitions) {

		// Build set of customized/cloned adapters
		var adHocAdapters = {};
		var i = 0;

		_.each(modelDefinitions, function eachModelDef (modelDef) {

			// Keep track of generated unique connection IDs
			var connectionIDs = [];

			_.each(modelDef.connection, function eachConnection (connection) {

				// Track unique, process-wide identifiers for each connection
				var connectionID = 'adhoc_adapter_' + i;
				connectionIDs.push(connectionID);
				i++;

				// Create and save new ad-hoc adapter
				adHocAdapters[connectionID] = _cloneAdapter({
					adapterID: connection.adapter,
					adapterDefs: sails.adapters,
					connection: connection,
					config: modelDef.config
				});
			});

			// Populate the `adapter` property in the model definition
			// with an array of the uniquely generated connection ID strings for this model.
			// TODO: in Waterline core, use `connectionNames` instead (or something like that)
			sails.log.silly('Setting Model.adapter with ad-hoc clone ids => ', connectionIDs);
			modelDef.adapter = connectionIDs;


			// Old way (replaced w/ generated connection names- since uniquness guarantee was hard to achieve)
			// ::::::::::::::::::::::::::::::::::::
			// Then pluck out the adapter ids from the model's connections 
			// and plug them as a list of strings into `Model.adapter`
			// modelDef.adapter = _.pluck(modelDef.connection, 'adapter');
		});

		return adHocAdapters;
	}


	/**
	 * _cloneAdapter
	 *
	 * Given the definitions of all relevant adapters,
	 * @returns a configured, ad-hoc adapter clone
	 *
	 * @param {Object} opts
	 * @api private
	 */
	function _cloneAdapter (opts) {

		// Options
		var adapterID = opts.adapterID;
		var adapterDefs = opts.adapterDefs;
		var connection = opts.connection;
		var config = opts.config;

		var clonedAdapter = _.cloneDeep( adapterDefs[adapterID] );
		var clonedConnection = _.cloneDeep( connection );

		clonedAdapter.config = 
			_.merge(
				clonedAdapter.defaults || {},
				clonedConnection,
				config);

		sails.log.silly(
			'Cloned new ad-hoc adapter','\n',
			'\t:: source adapter ::',adapterID, '\n',
			'\t:: source connection ::',connection, '\n',
			'\t:: config ::',clonedAdapter.config,'\n'
		);
		return clonedAdapter;
	}

};
