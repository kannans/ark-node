"use strict";

var _ = require('lodash');
var popsicle = require('popsicle');
var schema = require('../schema/peers.js');

// Private fields
var modules, library;


var __headers;

//
//__API__ `bind`

//
Peer.bind = function (scope) {
	modules = scope.modules;
	library = scope.library;
  __headers = {
		os: modules.system.getOS(),
		version: modules.system.getVersion(),
		port: modules.system.getPort(),
		nethash: modules.system.getNethash()
	};
};

// single Peer object
function Peer(ip, port, version, os){
	this.ip = ip;
	this.port = port;
	this.version = version;
	this.os = os;
	this.protocol = (port%1000)==443?"https":"http";
	this.liteclient = port < 80;
	this.status = "NEW";
	this.publicapi = false;
	this.headers;
	this.requests = 0;
	this.delay = 10000;
	this.lastchecked = 0;

	if(!this.liteclient){
		this.updateStatus();
		var that = this;
		this.intervalId = setInterval(
			function(){
				if(new Date().getTime() - that.lastchecked > 60000){
					that.updateStatus();
				}
			}, 60000);
	}
}

Peer.prototype.toObject = function(){
  return {
    ip: this.ip,
    port: this.port,
    version: this.version,
    os: this.os,
    height: this.height,
    status: this.status,
    delay: this.delay
  };
};

Peer.prototype.toString = function(){
  return this.protocol+"://"+this.ip+":"+this.port;
};

Peer.prototype.normalizeHeader = function(header){
  var result = {
    height: parseInt(header.height),
    port: parseInt(header.port),
    os: header.os,
    version: header.version,
    nethash: header.nethash
  };
  if(header.blockheader){
    result.blockheader = {
      id: header.blockheader.id,
      timestamp: header.blockheader.timestamp,
      signature: header.blockheader.signature,
      generatorPublicKey: header.blockheader.generatorPublicKey,
      version: header.blockheader.version,
      height: header.blockheader.height,
      numberOfTransactions: header.blockheader.numberOfTransactions,
      previousBlock: header.blockheader.previousBlock,
      totalAmount: header.blockheader.totalAmount,
      totalFee: header.blockheader.totalFee,
      reward: header.blockheader.reward,
      payloadLength: header.blockheader.payloadLength,
      payloadHash: header.blockheader.payloadHash
    };
  }
  return result;
};

Peer.prototype.updateStatus = function(){
  var that = this;
  this.get('/peer/height', function(err, res){
    if(!err){
      that.height = res.body.height;
      that.headers = res.body.header;
      try {
        // TODO: also check that the delegate was legit to forge the block ?
        // likely too much work since in the end we use only a few peers of the list
        // or maybe only the ones claiming height > current node height
        verification = modules.blocks.verifyBlockHeader(res.body.header);
      } catch (e) {
        library.logger.warn('Failed verifiy block header from', peer.toString());
        library.logger.warn("Error", e);
      }
      if(verification){
        that.status="FORK";
      } else{
        that.status="OK";
      }
    }
  });
  this.get('/api/blocks/getHeight', function(err, body){
    that.publicapi = !!err;
  });
};

Peer.prototype.fetchHeight = function(cb){
  this.get('/peer/height', cb);
}

Peer.prototype.accept = function(){
  this.lastchecked=new Date().getTime();
  return true;
};

Peer.prototype.get = function(api, cb){
  return this.request(api, {method:'GET'}, cb);
};

Peer.prototype.post = function(api, payload, cb){
  return this.request(api, {method:'POST', data:payload}, cb);
};

Peer.prototype.request = function(api, options, cb){
  var req = {
    url: this.protocol+'://' + this.ip + ':' + this.port + api,
    method: options.method,
    headers: _.extend({}, __headers, options.headers),
    timeout: options.timeout || library.config.peers.options.timeout
  };

  if (options.data) {
    req.body = options.data;
  }

  var request = popsicle.request(req);
  this.lastchecked=new Date().getTime();
  var that = this;
  request.use(popsicle.plugins.parse(['json'], false)).then(function (res) {
    that.delay=new Date().getTime()-that.lastchecked;
    if (res.status !== 200) {
      that.status="ERESPONSE";
      return cb(['Received bad response code', res.status, req.method, req.url].join(' '));
    } else {

      var header = that.normalizeHeader(res.headers);
      var report = library.schema.validate(header, schema.headers);

      if (!report) {
        // no valid transport header, considering a public API call
        if(that.status!="FORK"){
          that.status = "OK";
        }
        return cb(null, {body: res.body, peer: that.toObject()});
      }

      that.headers = header.blockheader;
      that.os = header.os;
      that.version = header.version;
      that.height = header.height;
      that.nethash = header.nethash;

      if (header.nethash !== library.config.nethash) {
        that.status="ENETHASH";
        return cb(['Peer is not on the same network', header.nethash, req.method, req.url].join(' '));
      }

      if(that.status!="FORK"){
        that.status = "OK";
      }

      return cb(null, {body: res.body, peer: that.toObject()});
    }
  })
  .catch(function (err) {
    if (err.code === 'EUNAVAILABLE' || err.code === 'ETIMEOUT') {
      that.status=err.code;
    }

    return cb([err.code, 'Request failed', req.method, req.url].join(' '));
  });
};


// Export
module.exports = Peer;