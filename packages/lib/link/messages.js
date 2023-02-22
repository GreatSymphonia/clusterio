// Message definitions for links
"use strict";
const libData = require("../data");
const libErrors = require("../errors");
const { logger } = require("../logging");
const libSchema = require("../schema");
const PlayerStats = require("../PlayerStats");

class MissingLinkHandlerError extends Error {
	constructor(type, source, target) {
		super();
		this.code = "MISSING_LINK_HANDLER";
		this.type = type;
		this.source = source;
		this.target = target;
		this.handler = null;
		this.plugin = null;
	}

	get message() {
		let handler = this.handler ? `${this.handler}` : "handler";
		let plugin = this.plugin ? ` on plugin ${this.plugin}` : "";

		return `Missing ${handler}${plugin} for ${this.type} on ${this.source}-${this.target} link`;
	}
}

/**
 * Represents a message that can be sent over the link
 *
 * @memberof module:lib/link
 */
class Message {
	/**
	 * Name of the plugin this message belongs to, or null.
	 * @returns {?string} - plugin name or null if not from a plugin.
	 */
	get plugin() {
		if (this._plugin === undefined) {
			let index = this.type.indexOf(":");
			this._plugin = index === -1 ? null : this.type.slice(0, index);
		}

		return this._plugin;
	}
}

/**
 * Represents a request sent over the link
 *
 * A request-response message that can be innitated by either party of the
 * link.
 *
 * @extends module:lib/link.Message
 * @memberof module:lib/link
 */
class Request extends Message {

	/**
	 * Creates a request
	 *
	 * @param {string} type -
	 *     message type used.  Will have suffix '_request' for the request
	 *     message and suffix '_response' for the response message.
	 * @param {Array<string>} links -
	 *     Links this request is valid on.  Takes an array of strings
	 *     containing "<source>-<target>" specifications.
	 * @param {?string} permission -
	 *     Permission required to send this request.  Only applies to
	 *     requests sent from control to controller.
	 * @param {?string} forwardTo -
	 *     Optional target to forward this request to.  'instance' add
	 *     instance_id into the requestProperties and forward to the given
	 *     instance.  'controller' forwards it to the controller.
	 * @param {?Array<string>} requestRequired -
	 *     List of properties that are required to be present in the data
	 *     payload of this request.  Defaults to all.
	 * @param {Object<string, Object>} requestProperties -
	 *     Mapping of property values to JSON schema specifications for the
	 *     properties that are valid in the data payload of this requst.
	 * @param {?Array<string>} responseRequired -
	 *     List of properties that are required to be present in the data
	 *     payload of the repsonse to this request.  Defaults to all.
	 * @param {Object<string, Object>} responseProperties -
	 *     Mapping of property values to JSON schema specifications for the
	 *     properties that are valid in the data payload of the response to
	 *     this requst.
	 */
	constructor({
		type, permission, links, forwardTo = null,
		requestRequired = null, requestProperties = {},
		responseRequired = null, responseProperties = {},
	}) {
		super();
		this.type = type;
		this.links = links;
		this.permission = permission || null;
		this.forwardTo = forwardTo;
		this.handlerSuffix = "RequestHandler";

		this.requestType = `${type}_request`;
		this.responseType = `${type}_response`;

		if (permission === undefined && links.includes("control-controller")) {
			throw new Error(`permission is required for ${this.type} request over control-controller links`);
		}
		if (permission && !links.includes("control-controller")) {
			throw new Error(
				`permission is not allowed on ${this.type} request as it is not over control-controller link`
			);
		}

		if (!requestRequired) {
			requestRequired = Object.keys(requestProperties);
		}

		if (forwardTo === "instance") {
			requestRequired = ["instance_id", ...requestRequired];
			requestProperties = {
				"instance_id": { type: "integer" },
				...requestProperties,
			};

		} else if (forwardTo !== "controller" && forwardTo !== null) {
			throw new Error(`Invalid forwardTo value ${forwardTo}`);
		}

		this._requestValidator = libSchema.compile({
			$schema: "http://json-schema.org/draft-07/schema#",
			properties: {
				"type": { const: this.requestType },
				"data": {
					additionalProperties: false,
					required: requestRequired,
					properties: requestProperties,
				},
			},
		});

		if (!responseRequired) {
			responseRequired = Object.keys(responseProperties);
		}

		this._responseValidator = libSchema.compile({
			$schema: "http://json-schema.org/draft-07/schema#",
			properties: {
				"type": { const: this.responseType },
				"data": {
					anyOf: [
						{
							additionalProperties: false,
							required: ["seq", ...responseRequired],
							properties: {
								"seq": { type: "integer" },
								...responseProperties,
							},
						},
						{
							additionalProperties: false,
							required: ["seq", "error"],
							properties: {
								"seq": { type: "integer" },
								"error": { type: "string" },
							},
						},
					],
				},
			},
		});
	}

	/**
	 * Attach to a link
	 *
	 * Set a the validator for the response on the given link if it's a
	 * source and sets the handler for the request if it is a target.
	 *
	 * If forwardTo was set to 'instance' the `forwardRequestToInstance`
	 * method on the link is used as the default handler.
	 *
	 * If forwardTo was set to 'controller' the `forwardRequesToController` method
	 * on the link is used as the default handler.
	 *
	 * Does nothing if the link is neither a source nor a target for this
	 * request.
	 *
	 * @param {Link} link - The link to attach to.
	 * @param {Function} handler -
	 *    Async function to invoke with link set as this to handle the
	 *    request request.  Only used on the target side.
	 * @throws {Error} if the handler is needed and not defined.
	 */
	attach(link, handler) {
		// Source side.
		if (this.links.includes(`${link.source}-${link.target}`)) {
			link.setValidator(this.responseType, this._responseValidator);
		}

		// Target side.  Note: Source and target is reversed here.
		if (this.links.includes(`${link.target}-${link.source}`)) {

			// Use forwarder if handler is not present.
			if (!handler) {
				if (this.forwardTo === "instance") {
					handler = link.forwardRequestToInstance;
				} else if (this.forwardTo === "controller") {
					handler = link.forwardRequestToController;
				}
			}

			if (!handler) {
				throw new MissingLinkHandlerError(this.requestType, link.source, link.target);
			}

			// Check permission if this is a handler for a control connection on the controller
			if (this.permission !== null && `${link.source}-${link.target}` === "controller-control") {
				let origHandler = handler;
				handler = async function(message, request) {
					// Abuse this binding to get a hold of the ControlConnection instance
					// eslint-disable-next-line no-invalid-this, consistent-this
					let controlConnection = this;
					controlConnection.user.checkPermission(request.permission);
					return await origHandler.call(controlConnection, message, request);
				};
			}

			link.setHandler(this.requestType, message => {
				handler.call(link, message, this).then(response => {
					if (response === undefined) {
						// XXX Should we allow implicit responses like this?
						response = {};
					}

					let data = { ...response, seq: message.seq };
					if (!this._responseValidator({ seq: 0, type: this.responseType, data })) {
						logger.error(JSON.stringify(this._responseValidator.errors, null, 4));
						throw new Error(`Validation failed responding to ${this.requestType}`);
					}

					link.connector.send(this.responseType, data);

				}).catch(err => {
					if (!(err instanceof libErrors.RequestError)) {
						logger.error(`Unexpected error while responding to ${this.requestType}:\n${err.stack}`);
					}
					link.connector.send(this.responseType, { seq: message.seq, error: err.message });
				});
			}, this._requestValidator);
		}
	}

	/**
	 * Send request over the given link
	 *
	 * Sends the given data over the link as the request payload and waits
	 * for the response.
	 *
	 * @param {module:lib/link.Link} link - Link to send request over.
	 * @param {Object} data - Data to send with the request.
	 * @returns {Promise<object>} response data
	 */
	async send(link, data = {}) {
		// XXX validate link target/source?
		if (!this._requestValidator({ seq: 0, type: this.requestType, data })) {
			logger.error(JSON.stringify(this._requestValidator.errors, null, 4));
			throw new Error(`Validation failed sending ${this.requestType}`);
		}
		let seq = link.connector.send(this.requestType, data);
		let responseMessage = await link.waitFor(this.responseType, { seq });
		if (responseMessage.data.error) {
			throw new libErrors.RequestError(responseMessage.data.error);
		}
		return responseMessage.data;
	}
}


let messages = {};

// Connection requests
let wsLinks = ["controller-control", "control-controller", "controller-host", "host-controller"];
messages.prepareDisconnect = new Request({
	type: "prepare_disconnect",
	links: wsLinks,
	permission: null,
});

messages.prepareControllerDisconnect = new Request({
	type: "prepare_controller_disconnect",
	links: ["host-instance"],
});

messages.ping = new Request({
	type: "ping",
	links: wsLinks,
	permission: null,
});

messages.debugDumpWs = new Request({
	type: "debug_dump_ws",
	links: ["control-controller"],
	permission: "core.debug.dump_ws",
});


// Management requests
messages.getControllerConfig = new Request({
	type: "get_controller_config",
	links: ["control-controller"],
	permission: "core.controller.get_config",
	responseProperties: {
		"serialized_config": { type: "object" },
	},
});

messages.setControllerConfigField = new Request({
	type: "set_controller_config_field",
	links: ["control-controller"],
	permission: "core.controller.update_config",
	requestProperties: {
		"field": { type: "string" },
		"value": { type: "string" },
	},
});

messages.setControllerConfigProp = new Request({
	type: "set_controller_config_prop",
	links: ["control-controller"],
	permission: "core.controller.update_config",
	requestRequired: ["field", "prop"],
	requestProperties: {
		"field": { type: "string" },
		"prop": { type: "string" },
		"value": {},
	},
});

let hostProperties = {
	"agent": { type: "string" },
	"version": { type: "string" },
	"name": { type: "string" },
	"id": { type: "integer" },
	"connected": { type: "boolean" },
	"public_address": { type: ["null", "string"] },
};

messages.listHosts = new Request({
	type: "list_hosts",
	links: ["control-controller"],
	permission: "core.host.list",
	responseProperties: {
		"list": {
			type: "array",
			items: {
				additionalProperties: false,
				required: ["agent", "version", "name", "id", "connected"],
				properties: hostProperties,
			},
		},
	},
});

messages.setHostSubscriptions = new Request({
	type: "set_host_subscriptions",
	links: ["control-controller"],
	permission: "core.host.subscribe",
	requestProperties: {
		"all": { type: "boolean" },
		"host_ids": {
			type: "array",
			items: { type: "integer" },
		},
	},
});

let instanceProperties = {
	"name": { type: "string" },
	"id": { type: "integer" },
	"assigned_host": { type: ["null", "integer"] },
	"game_port": { type: ["null", "integer"] },
	"status": { enum: [
		"unknown", "unassigned", "stopped", "starting", "running", "stopping",
		"creating_save", "exporting_data", "deleted",
	]},
};

messages.getInstance = new Request({
	type: "get_instance",
	links: ["control-controller"],
	permission: "core.instance.get",
	requestProperties: {
		"id": { type: "integer" },
	},
	responseProperties: instanceProperties,
});

messages.listInstances = new Request({
	type: "list_instances",
	links: ["control-controller"],
	permission: "core.instance.list",
	responseProperties: {
		"list": {
			type: "array",
			items: {
				additionalProperties: false,
				required: ["name", "id", "assigned_host", "status"],
				properties: instanceProperties,
			},
		},
	},
});

messages.setInstanceSubscriptions = new Request({
	type: "set_instance_subscriptions",
	links: ["control-controller"],
	permission: "core.instance.subscribe",
	requestProperties: {
		"all": { type: "boolean" },
		"instance_ids": {
			type: "array",
			items: { type: "integer" },
		},
	},
});

messages.generateHostToken = new Request({
	type: "generate_host_token",
	links: ["control-controller"],
	permission: "core.host.generate_token",
	requestProperties: {
		"host_id": { type: ["integer", "null"] },
	},
	responseProperties: {
		"token": { type: "string" },
	},
});

messages.createHostConfig = new Request({
	type: "create_host_config",
	links: ["control-controller"],
	permission: "core.host.create_config",
	requestProperties: {
		"id": { type: ["integer", "null"] },
		"name": { type: ["string", "null"] },
		"generate_token": { type: "boolean" },
	},
	responseProperties: {
		"serialized_config": { type: "object" },
	},
});

messages.createInstance = new Request({
	type: "create_instance",
	links: ["control-controller"],
	permission: "core.instance.create",
	requestProperties: {
		"serialized_config": { type: "object" },
	},
});

messages.getInstanceConfig = new Request({
	type: "get_instance_config",
	links: ["control-controller"],
	permission: "core.instance.get_config",
	requestProperties: {
		"instance_id": { type: "integer" },
	},
	responseProperties: {
		"serialized_config": { type: "object" },
	},
});

messages.setInstanceConfigField = new Request({
	type: "set_instance_config_field",
	links: ["control-controller"],
	permission: "core.instance.update_config",
	requestProperties: {
		"instance_id": { type: "integer" },
		"field": { type: "string" },
		"value": { type: "string" },
	},
});

messages.setInstanceConfigProp = new Request({
	type: "set_instance_config_prop",
	links: ["control-controller"],
	permission: "core.instance.update_config",
	requestRequired: ["instance_id", "field", "prop"],
	requestProperties: {
		"instance_id": { type: "integer" },
		"field": { type: "string" },
		"prop": { type: "string" },
		"value": {},
	},
});

messages.assignInstanceCommand = new Request({
	type: "assign_instance_command",
	links: ["control-controller"],
	permission: "core.instance.assign",
	requestProperties: {
		"instance_id": { type: "integer" },
		"host_id": { type: ["integer", "null"] },
	},
});

messages.startInstance = new Request({
	type: "start_instance",
	links: ["control-controller", "controller-host", "host-instance"],
	permission: "core.instance.start",
	requestProperties: {
		"save": { type: ["string", "null"] },
	},
	forwardTo: "instance",
});

let saveList = {
	type: "array",
	items: {
		type: "object",
		additionalProperties: false,
		required: ["type", "name", "size", "mtime_ms", "loaded"],
		properties: {
			"type": { enum: ["file", "directory", "special"] },
			"name": { type: "string" },
			"size": { type: "integer" },
			"mtime_ms": { type: "number" },
			"loaded": { type: "boolean" },
			"default": { type: "boolean" },
		},
	},
};

messages.listSaves = new Request({
	type: "list_saves",
	links: ["control-controller", "controller-host", "host-instance"],
	permission: "core.instance.save.list",
	forwardTo: "instance",
	responseProperties: {
		"list": saveList,
	},
});

messages.createSave = new Request({
	type: "create_save",
	links: ["control-controller", "controller-host", "host-instance"],
	permission: "core.instance.save.create",
	forwardTo: "instance",
	requestProperties: {
		"name": { type: "string" },
		"seed": { type: ["integer", "null"] },
		"map_gen_settings": { type: ["object", "null"] },
		"map_settings": { type: ["object", "null"] },
	},
});

messages.renameSave = new Request({
	type: "rename_save",
	links: ["control-controller", "controller-host"],
	permission: "core.instance.save.rename",
	forwardTo: "instance",
	requestProperties: {
		"old_name": { type: "string" },
		"new_name": { type: "string" },
	},
});

messages.copySave = new Request({
	type: "copy_save",
	links: ["control-controller", "controller-host"],
	permission: "core.instance.save.copy",
	forwardTo: "instance",
	requestProperties: {
		"source": { type: "string" },
		"destination": { type: "string" },
	},
});

messages.deleteSave = new Request({
	type: "delete_save",
	links: ["control-controller", "controller-host"],
	permission: "core.instance.save.delete",
	forwardTo: "instance",
	requestProperties: {
		"save": { type: "string" },
	},
});

messages.downloadSave = new Request({
	type: "download_save",
	links: ["control-controller"],
	permission: "core.instance.save.download",
	requestProperties: {
		"instance_id": { type: "integer" },
		"save": { type: "string" },
	},
	responseProperties: {
		"stream_id": { type: "string" },
	},
});

messages.transferSave = new Request({
	type: "transfer_save",
	links: ["control-controller", "controller-host"],
	permission: "core.instance.save.transfer",
	requestProperties: {
		"instance_id": { type: "integer" },
		"source_save": { type: "string" },
		"target_instance_id": { type: "integer" },
		"target_save": { type: "string" },
		"copy": { type: "boolean" },
	},
	responseProperties: {
		"save": { type: "string" },
	},
});

messages.pullSave = new Request({
	type: "pull_save",
	links: ["controller-host"],
	requestProperties: {
		"instance_id": { type: "integer" },
		"stream_id": { type: "string" },
		"filename": { type: "string" },
	},
	responseProperties: {
		"save": { type: "string" },
	},
});

messages.pushSave = new Request({
	type: "push_save",
	links: ["controller-host"],
	requestProperties: {
		"instance_id": { type: "integer" },
		"stream_id": { type: "string" },
		"save": { type: "string" },
	},
});

messages.setSaveListSubscriptions = new Request({
	type: "set_save_list_subscriptions",
	links: ["control-controller"],
	permission: "core.instance.save.list_subscribe",
	requestProperties: {
		"all": { type: "boolean" },
		"instance_ids": {
			type: "array",
			items: { type: "integer" },
		},
	},
});

messages.loadScenario = new Request({
	type: "load_scenario",
	links: ["control-controller", "controller-host", "host-instance"],
	permission: "core.instance.load_scenario",
	forwardTo: "instance",
	requestProperties: {
		"scenario": { type: "string" },
		"seed": { type: ["integer", "null"] },
		"map_gen_settings": { type: ["object", "null"] },
		"map_settings": { type: ["object", "null"] },
	},
});

messages.exportData = new Request({
	type: "export_data",
	links: ["control-controller", "controller-host", "host-instance"],
	permission: "core.instance.export_data",
	forwardTo: "instance",
});

messages.extractPlayers = new Request({
	type: "extract_players",
	links: ["control-controller", "controller-host", "host-instance"],
	permission: "core.instance.extract_players",
	forwardTo: "instance",
});

messages.stopInstance = new Request({
	type: "stop_instance",
	links: ["control-controller", "controller-host", "host-instance"],
	permission: "core.instance.stop",
	forwardTo: "instance",
});

messages.killInstance = new Request({
	type: "kill_instance",
	links: ["control-controller", "controller-host", "host-instance"],
	permission: "core.instance.kill",
	forwardTo: "instance",
});

messages.deleteInstance = new Request({
	type: "delete_instance",
	links: ["control-controller", "controller-host"],
	permission: "core.instance.delete",
	forwardTo: "instance",
});

messages.sendRcon = new Request({
	type: "send_rcon",
	links: ["control-controller", "controller-host", "host-instance"],
	permission: "core.instance.send_rcon",
	forwardTo: "instance",
	requestProperties: {
		"command": { type: "string" },
	},
	responseProperties: {
		"result": { type: "string" },
	},
});

messages.getModPack = new Request({
	type: "get_mod_pack",
	links: ["control-controller", "instance-host", "host-controller"],
	permission: "core.mod_pack.get",
	forwardTo: "controller",
	requestProperties: {
		"id": { type: "integer" },
	},
	responseProperties: {
		"mod_pack": libData.ModPack.jsonSchema,
	},
});

messages.getDefaultModPack = new Request({
	type: "get_default_mod_pack",
	links: ["control-controller", "instance-host", "host-controller"],
	permission: "core.mod_pack.get",
	forwardTo: "controller",
	responseProperties: {
		"mod_pack": libData.ModPack.jsonSchema,
	},
});

messages.listModPacks = new Request({
	type: "list_mod_packs",
	links: ["control-controller"],
	permission: "core.mod_pack.list",
	responseProperties: {
		"list": {
			type: "array",
			items: libData.ModPack.jsonSchema,
		},
	},
});

messages.createModPack = new Request({
	type: "create_mod_pack",
	links: ["control-controller"],
	permission: "core.mod_pack.create",
	requestProperties: {
		"mod_pack": libData.ModPack.jsonSchema,
	},
});

messages.updateModPack = new Request({
	type: "update_mod_pack",
	links: ["control-controller"],
	permission: "core.mod_pack.update",
	requestProperties: {
		"mod_pack": libData.ModPack.jsonSchema,
	},
});

messages.deleteModPack = new Request({
	type: "delete_mod_pack",
	links: ["control-controller"],
	permission: "core.mod_pack.delete",
	requestProperties: {
		"id": { type: "integer" },
	},
});

messages.setModPackSubscriptions = new Request({
	type: "set_mod_pack_subscriptions",
	links: ["control-controller"],
	permission: "core.mod_pack.subscribe",
	requestProperties: {
		"all": { type: "boolean" },
		"mod_pack_ids": {
			type: "array",
			items: { type: "integer" },
		},
	},
});

messages.getMod = new Request({
	type: "get_mod",
	links: ["control-controller"],
	permission: "core.mod.get",
	requestProperties: {
		"name": { type: "string" },
		"version": { type: "string" },
	},
	responseProperties: {
		"mod": libData.ModInfo.jsonSchema,
	},
});

messages.listMods = new Request({
	type: "list_mods",
	links: ["control-controller"],
	permission: "core.mod.list",
	responseProperties: {
		"list": {
			type: "array",
			items: libData.ModInfo.jsonSchema,
		},
	},
});

messages.searchMods = new Request({
	type: "search_mods",
	links: ["control-controller"],
	permission: "core.mod.search",
	requestRequired: ["query", "factorio_version", "page"],
	requestProperties: {
		"query": { type: "string" },
		"factorio_version": { type: "string" },
		"page_size": { type: "integer" },
		"page": { type: "integer" },
		"sort": { type: "string" },
		"sort_order": { type: "string" },
	},
	responseProperties: {
		"query_issues": {
			type: "array",
			items: { type: "string" },
		},
		"page_count": { type: "integer" },
		"result_count": { type: "integer" },
		"results": {
			type: "array",
			items: {
				type: "object",
				properties: {
					"name": { type: "string" },
					"versions": {
						type: "array",
						items: libData.ModInfo.jsonSchema,
					},
				},
			},
		},
	},
});

messages.setModSubscriptions = new Request({
	type: "set_mod_subscriptions",
	links: ["control-controller"],
	permission: "core.mod.subscribe",
	requestProperties: {
		"all": { type: "boolean" },
		"mod_names": {
			type: "array",
			items: { type: "string" },
		},
	},
});

messages.downloadMod = new Request({
	type: "download_mod",
	links: ["control-controller"],
	permission: "core.mod.download",
	requestProperties: {
		"name": { type: "string" },
		"version": { type: "string" },
	},
	responseProperties: {
		"stream_id": { type: "string" },
	},
});

messages.deleteMod = new Request({
	type: "delete_mod",
	links: ["control-controller"],
	permission: "core.mod.delete",
	requestProperties: {
		"name": { type: "string" },
		"version": { type: "string" },
	},
});

messages.listPermissions = new Request({
	type: "list_permissions",
	links: ["control-controller"],
	permission: "core.permission.list",
	responseProperties: {
		"list": {
			type: "array",
			items: {
				additionalProperties: false,
				required: ["name", "title", "description"],
				properties: {
					"name": { type: "string" },
					"title": { type: "string" },
					"description": { type: "string" },
				},
			},
		},
	},
});

messages.listRoles = new Request({
	type: "list_roles",
	links: ["control-controller"],
	permission: "core.role.list",
	responseProperties: {
		"list": {
			type: "array",
			items: {
				additionalProperties: false,
				required: ["id", "name", "description", "permissions"],
				properties: {
					"id": { type: "integer" },
					"name": { type: "string" },
					"description": { type: "string" },
					"permissions": { type: "array", items: { type: "string" }},
				},
			},
		},
	},
});

messages.createRole = new Request({
	type: "create_role",
	links: ["control-controller"],
	permission: "core.role.create",
	requestProperties: {
		"name": { type: "string" },
		"description": { type: "string" },
		"permissions": { type: "array", items: { type: "string" }},
	},
	responseProperties: {
		"id": { type: "integer" },
	},
});

messages.updateRole = new Request({
	type: "update_role",
	links: ["control-controller"],
	permission: "core.role.update",
	requestProperties: {
		"id": { type: "integer" },
		"name": { type: "string" },
		"description": { type: "string" },
		"permissions": { type: "array", items: { type: "string" }},
	},
});

messages.grantDefaultRolePermissions = new Request({
	type: "grant_default_role_permissions",
	links: ["control-controller"],
	permission: "core.role.update",
	requestProperties: {
		"id": { type: "integer" },
	},
});

messages.deleteRole = new Request({
	type: "delete_role",
	links: ["control-controller"],
	permission: "core.role.delete",
	requestProperties: {
		"id": { type: "integer" },
	},
});

const userRequired = ["name", "roles", "instances"];
const userProperties = {
	"name": { type: "string" },
	"roles": { type: "array", items: { type: "integer" }},
	"is_admin": { type: "boolean" },
	"is_banned": { type: "boolean" },
	"is_whitelisted": { type: "boolean" },
	"ban_reason": { type: "string" },
	"instances": { type: "array", items: { type: "integer" }},
	"is_deleted": { type: "boolean" },
	"player_stats": PlayerStats.jsonSchema,
	"instance_stats": {
		type: "array",
		items: {
			type: "array",
			items: [{ type: "integer" }, PlayerStats.jsonSchema],
		},
	},
};

messages.getUser = new Request({
	type: "get_user",
	links: ["control-controller"],
	permission: "core.user.get",
	requestProperties: {
		"name": { type: "string" },
	},
	responseRequired: userRequired,
	responseProperties: userProperties,
});

messages.listUsers = new Request({
	type: "list_users",
	links: ["control-controller"],
	permission: "core.user.list",
	responseProperties: {
		"list": {
			type: "array",
			items: {
				additionalProperties: false,
				required: userRequired,
				properties: userProperties,
			},
		},
	},
});

messages.setUserSubscriptions = new Request({
	type: "set_user_subscriptions",
	links: ["control-controller"],
	permission: "core.user.subscribe",
	requestProperties: {
		"all": { type: "boolean" },
		"names": {
			type: "array",
			items: { type: "string" },
		},
	},
});

messages.createUser = new Request({
	type: "create_user",
	links: ["control-controller"],
	permission: "core.user.create",
	requestProperties: {
		"name": { type: "string" },
	},
});

messages.revokeUserToken = new Request({
	type: "revoke_user_token",
	links: ["control-controller"],
	permission: "core.user.revoke_token",
	requestProperties: {
		"name": { type: "string" },
	},
});

messages.updateUserRoles = new Request({
	type: "update_user_roles",
	links: ["control-controller"],
	permission: "core.user.update_roles",
	requestProperties: {
		"name": { type: "string" },
		"roles": { type: "array", items: { type: "integer" }},
	},
});

messages.setUserAdmin = new Request({
	type: "set_user_admin",
	links: ["control-controller"],
	permission: "core.user.set_admin",
	requestProperties: {
		"name": { type: "string" },
		"create": { type: "boolean" },
		"admin": { type: "boolean" },
	},
});

messages.setUserWhitelisted = new Request({
	type: "set_user_whitelisted",
	links: ["control-controller"],
	permission: "core.user.set_whitelisted",
	requestProperties: {
		"name": { type: "string" },
		"create": { type: "boolean" },
		"whitelisted": { type: "boolean" },
	},
});

messages.setUserBanned = new Request({
	type: "set_user_banned",
	links: ["control-controller"],
	permission: "core.user.set_banned",
	requestProperties: {
		"name": { type: "string" },
		"create": { type: "boolean" },
		"banned": { type: "boolean" },
		"reason": { type: "string" },
	},
});

messages.deleteUser = new Request({
	type: "delete_user",
	links: ["control-controller"],
	permission: "core.user.delete",
	requestProperties: {
		"name": { type: "string" },
	},
});

messages.setLogSubscriptions = new Request({
	type: "set_log_subscriptions",
	links: ["control-controller"],
	permission: "core.log.follow",
	requestProperties: {
		"all": { type: "boolean" },
		"controller": { type: "boolean" },
		"host_ids": {
			type: "array",
			items: { type: "integer" },
		},
		"instance_ids": {
			type: "array",
			items: { type: "integer" },
		},
		"max_level": { type: ["string", "null"] },
	},
});

messages.queryLog = new Request({
	type: "query_log",
	links: ["control-controller"],
	permission: "core.log.query",
	requestProperties: {
		"all": { type: "boolean" },
		"controller": { type: "boolean" },
		"host_ids": {
			type: "array",
			items: { type: "integer" },
		},
		"instance_ids": {
			type: "array",
			items: { type: "integer" },
		},
		"max_level": { type: ["string", "null"] },
		"limit": { type: "integer" },
		"order": { enum: ["asc", "desc"] },
	},
	responseProperties: {
		"log": {
			type: "array",
			items: { type: "object" },
		},
	},
});


// Internal requests
messages.updateInstances = new Request({
	type: "update_instances",
	links: ["host-controller"],
	requestProperties: {
		"instances": {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["serialized_config", "status"],
				properties: {
					"serialized_config": { type: "object" },
					"status": { enum: [
						"stopped", "starting", "running", "stopping", "creating_save", "exporting_data",
					]},
				},
			},
		},
	},
});

messages.assignInstance = new Request({
	type: "assign_instance",
	links: ["controller-host"],
	requestProperties: {
		"serialized_config": { type: "object" },
	},
	forwardTo: "instance",
});

messages.unassignInstance = new Request({
	type: "unassigne_instance",
	links: ["controller-host"],
	forwardTo: "instance",
});

messages.getMetrics = new Request({
	type: "get_metrics",
	links: ["controller-host", "host-instance"],
	responseProperties: {
		"results": { type: "array" },
	},
});


/**
 * Represents an event sent over the link
 *
 * A one way message without any response or recipt confirmation that
 * can be innitiated by either party of the link.
 *
 * @extends module:lib/link.Message
 * @memberof module:lib/link
 */
class Event extends Message {

	/**
	 * Creates an event
	 *
	 * @param {string} type -
	 *     message type used.  Will have suffix '_event' appended to it for
	 *     the messages sent through this event.
	 * @param {Array<string>} links -
	 *     Links this event is valid on.  Takes an array of strings
	 *     containing "<source>-<target>" specifications.
	 * @param {?string} forwardTo -
	 *     Optional target to forward this request to.  Supported values are
	 *     'controller' and 'instance'.  If set to 'instance' an instance_id
	 *     property is implicity added to eventProperties.
	 * @param {?string} broadcastTo -
	 *     Optional target to broadcast this event to.  Only 'instance' is
	 *     currently supported.  An event will only be broadcast towards
	 *     links that are downstream, so sending an event set to instance
	 *     broadcast that's sent to a host will only be broadcast to that
	 *     host's instances.
	 * @param {?Array<string>} eventRequired -
	 *     List of properties required to be present in the event payload.
	 *     Defaults to all.
	 * @param {Object<string, Object>} eventProperties -
	 *     Mapping of property values to JSON schema specifications for the
	 *     properties that are valid in the data payload of this event.
	 */
	constructor({ type, links, forwardTo = null, broadcastTo = null, eventRequired = null, eventProperties = {} }) {
		super();
		this.type = type;
		this.links = links;
		this.forwardTo = forwardTo;
		this.broadcastTo = broadcastTo;
		this.handlerSuffix = "EventHandler";

		if (!eventRequired) {
			eventRequired = Object.keys(eventProperties);
		}

		if (forwardTo === "instance") {
			eventRequired = ["instance_id", ...eventRequired];
			eventProperties = {
				"instance_id": { type: "integer" },
				...eventProperties,
			};

		} else if (forwardTo !== "controller" && forwardTo !== null) {
			throw new Error(`Invalid forwardTo value ${forwardTo}`);
		}

		if (broadcastTo !== "instance" && broadcastTo !== null) {
			throw new Error(`Invalid broadcastTo value ${broadcastTo}`);
		}

		this.eventType = `${type}_event`;
		this._eventValidator = libSchema.compile({
			$schema: "http://json-schema.org/draft-07/schema#",
			properties: {
				"type": { const: this.eventType },
				"data": {
					additionalProperties: false,
					required: eventRequired,
					properties: eventProperties,
				},
			},
		});
	}

	/**
	 * Attach to a link
	 *
	 * Set a the handler for the event on the given link if it's a target
	 * for the event.
	 *
	 * If forwardTo was set to 'controller' the `forwardEventToController` method on
	 * the link is used as the default handler.  If it was set to 'instance'
	 * the `forwardEventToInstance` method on the link is used by default.
	 *
	 * If broadcastTo was set to 'instance' the `broadcastEventToInstance`
	 * method on the link is invoked before the handler.
	 *
	 * Does nothing if the link is not a target for this event.
	 *
	 * @param {Link} link - The link to attach to.
	 * @param {Function} handler -
	 *    Async function to invoke with link set as this to handle the
	 *    event.  Only used on the target side.
	 * @throws {Error} if the handler is needed and not defined.
	 */
	attach(link, handler) {
		// Target side.  Note: Source and target is reversed here.
		if (this.links.includes(`${link.target}-${link.source}`)) {
			// Use forwarder if handler is not present.
			if (!handler) {
				if (this.forwardTo === "instance") {
					handler = link.forwardEventToInstance;
				} else if (this.forwardTo === "controller") {
					handler = link.forwardEventToController;
				}
			}

			if (
				this.broadcastTo === "instance"
				&& [
					"instance-host", "host-controller", "control-controller", "controller-host",
				].includes(`${link.target}-${link.source}`)
			) {
				if (!handler) {
					handler = link.broadcastEventToInstance;
				} else {
					let originalHandler = handler;
					handler = async (message, event) => {
						await link.broadcastEventToInstance(message, event);
						await originalHandler.call(link, message, event);
					};
				}
			}

			if (!handler) {
				throw new MissingLinkHandlerError(this.eventType, link.source, link.target);
			}

			link.setHandler(this.eventType, message => {
				// XXX Should event handlers even be allowed to be async?
				handler.call(link, message, this).catch(err => {
					logger.error(`Unexpected error while handling ${this.eventType}:\n${err.stack}`);
				});
			}, this._eventValidator);
		}
	}

	/**
	 * Send event over the given link
	 *
	 * Sends the given event data over the link.
	 *
	 * @param {module:lib/link.Link} link - Link to send event over.
	 * @param {Object} data - Data to send with the event.
	 */
	send(link, data = {}) {
		if (!this._eventValidator({ seq: 0, type: this.eventType, data })) {
			logger.error(JSON.stringify(this._eventValidator.errors, null, 4));
			throw new Error(`Validation failed sending ${this.eventType}`);
		}

		link.connector.send(this.eventType, data);
	}
}

messages.debugWsMessage = new Event({
	type: "debug_ws_message",
	links: ["controller-control"],
	eventProperties: {
		"direction": { type: "string" },
		"content": { type: "string" },
	},
});

messages.accountUpdate = new Event({
	type: "account_update",
	links: ["controller-control"],
	eventRequired: [],
	eventProperties: {
		"roles": {
			type: "array",
			items: {
				additionalProperties: false,
				type: "object",
				required: ["name", "id", "permissions"],
				properties: {
					"name": { type: "string" },
					"id": { type: "integer" },
					"permissions": {
						type: "array",
						items: { type: "string" },
					},
				},
			},
		},
	},
});

messages.logMessage = new Event({
	type: "log_message",
	links: ["host-controller", "controller-control"],
	eventProperties: {
		"info": {
			type: "object",
			required: ["level", "message"],
			properties: {
				"level": { type: "string" },
				"message": { type: "string" },
			},
		},
	},
});

messages.hostUpdate = new Event({
	type: "host_update",
	links: ["controller-control"],
	eventProperties: hostProperties,
});


messages.instanceInitialized = new Event({
	type: "instance_initialized",
	links: ["instance-host"],
	eventProperties: {
		"instance_id": { type: "integer" },
		"plugins": {
			type: "object",
			additionalProperties: { type: "string" },
		},
	},
});
messages.instanceStatusChanged = new Event({
	type: "instance_status_changed",
	links: ["instance-host", "host-controller"],
	eventRequired: ["instance_id", "status"],
	eventProperties: {
		"instance_id": { type: "integer" },
		"status": { enum: [
			"stopped", "starting", "running", "stopping", "creating_save", "exporting_data",
		]},
		"game_port": { type: ["null", "integer"] },
	},
});

messages.instanceUpdate = new Event({
	type: "instance_update",
	links: ["controller-control"],
	eventProperties: instanceProperties,
});

messages.saveListUpdate = new Event({
	type: "save_list_update",
	links: ["instance-host", "host-controller", "controller-control"],
	forwardTo: "controller",
	eventProperties: {
		"instance_id": { type: "integer" },
		"list": saveList,
	},
});

messages.modPackUpdate = new Event({
	type: "mod_pack_update",
	links: ["controller-control"],
	eventProperties: {
		"mod_pack": libData.ModPack.jsonSchema,
	},
});

messages.modUpdate = new Event({
	type: "mod_update",
	links: ["controller-control"],
	eventProperties: {
		"mod": libData.ModInfo.jsonSchema,
	},
});

messages.userUpdate = new Event({
	type: "user_update",
	links: ["controller-control"],
	eventRequired: userRequired,
	eventProperties: userProperties,
});

messages.controllerConnectionEvent = new Event({
	type: "controller_connection_event",
	links: ["host-instance"],
	eventProperties: {
		"event": { type: "string" },
	},
});

messages.syncUserLists = new Event({
	type: "sync_user_lists",
	links: ["controller-host"],
	eventProperties: {
		"adminlist": {
			type: "array",
			items: { type: "string" },
		},
		"banlist": {
			type: "array",
			items: {
				type: "array",
				additionalItems: false,
				items: [{ type: "string" }, { type: "string" }],
			},
		},
		"whitelist": {
			type: "array",
			items: { type: "string" },
		},
	},
});

messages.banlistUpdate = new Event({
	type: "banlist_update",
	links: ["controller-host", "host-instance"],
	broadcastTo: "instance",
	eventProperties: {
		"name": { type: "string" },
		"banned": { type: "boolean" },
		"reason": { type: "string" },
	},
});

messages.adminlistUpdate = new Event({
	type: "adminlist_update",
	links: ["controller-host", "host-instance"],
	eventProperties: {
		"name": { type: "string" },
		"admin": { type: "boolean" },
	},
	broadcastTo: "instance",
});

messages.whitelistUpdate = new Event({
	type: "whitelist_update",
	links: ["controller-host", "host-instance"],
	eventProperties: {
		"name": { type: "string" },
		"whitelisted": { type: "boolean" },
	},
	broadcastTo: "instance",
});

messages.playerEvent = new Event({
	type: "player_event",
	links: ["instance-host", "host-controller"],
	forwardTo: "controller",
	eventRequired: ["instance_id", "type", "name"],
	eventProperties: {
		"instance_id": { type: "integer" },
		"type": { type: "string", enum: ["join", "leave", "import"] },
		"name": { type: "string" },
		"reason": { type: "string" },
		"stats": PlayerStats.jsonSchema,
	},
});

/**
 * Attaches all requests and events to the given link
 *
 * Loops through all builtin messages defined and attaches all of them
 * to the link.  The handler used for the messageis looked up on the
 * link instance as the concatenation of the name of the message, the
 * name of message class, and 'Handler'.
 *
 * @param {module:lib/link.Link} link - Link to attach messages to.
 * @memberof module:lib/link
 */
function attachAllMessages(link) {
	for (let [name, message] of Object.entries(messages)) {
		let handler = `${name}${message.handlerSuffix}`;
		try {
			message.attach(link, link[handler]);
		} catch (err) {
			if (err.code === "MISSING_LINK_HANDLER") {
				err.handler = handler;
			}
			throw err;
		}
	}
}


module.exports = {
	Message,
	Request,
	Event,

	attachAllMessages,

	messages,
};
