#!/usr/bin/env node
/*
dangoco-node.js client

Copyright 2017 dangoco
*/
'use strict';

const commander = require('commander');
	
commander
	.usage('[options]')
	//server options
	.option('-s, --server [value]', 'server address. example: ws://127.0.0.1:80')
	.option('-u, --user [value]', 'username')
	.option('-p, --pass [value]', 'password')
	.option('--keyLength', 'set the byteLength of ramdon key,max is 128. default: 33')
	//socks options
	.option('--socksHost [value]', 'listen on the host for socks proxy. example: 127.0.0.1')
	.option('--socksPort <n>', 'listen on the port for socks proxy. example: 1080')
	//connections options
	.option('-a, --algo [value]', 'encryption algorithm,defaults to undefined. This should only be set in the insecurity connection')
	.option('--algolist', 'list all available algorithms')
	.option('-I, --idle <n>', 'idleTimeout,the connection will be automatically close after this idle time')
	////.option('--udpInTunnel', 'deliver udp packet in tunnel')
	.option('--ignore-error', 'keep running when having uncaught exception')
	.option('--disable-deflate', 'disable websocket deflate')
	.option('--keepBrokenTunnel', 'not close the tunnel when connection lost.(for bad network conditions)')
	.option('--connectionPerRequest', 'create a connection for every request')
	.option('--connectionPerTarget', 'create a connection for every target')
	.option('--connectionPerTCP', 'create a connection for every tcp request')
	.option('--connectionPerUDP', 'create a connection for every udp request')
	.option('--connectionForUDP', 'create a connection for all udp request')
	//other
	.option('-v', 'display the version')
	.parse(process.argv);

//--algolist
if(commander.algolist){//list all available algorithms
	console.log(require('crypto').getCiphers().join('\n'));
	return;
}
//-v
if(commander.V){//display the version
	console.log(`dangoco version: ${require('./package.json').version}`);
	return;
}

if(commander.ignoreError){
	process.on('uncaughtException',function(e){//prevent server from stoping when uncaughtException occurs
	    console.error(e);
	});
}

//create a dangoco client
const {dangocoClient}=require('./lib/client.js'),
	net=require('net');

//options check
if(commander.idle && !(commander.idle>=0))
	throw(new Error('Invalid idleTimeout'));
if(typeof commander.user !== 'string' || commander.user.length===0)
	throw(new Error('Wrong username'));


const dangocoConfig={
	server:commander.server,
	user:commander.user,
	pass:commander.pass,
	algo:commander.algo,
	idle:commander.idle,
	keyLength:commander.keyLength||33,
	udpInTunnel:/*commander.udpInTunnel||false*/true,
},
proxyConfig={
	connectionPerRequest:commander.connectionPerRequest||false,
	connectionPerTarget:commander.connectionPerTarget||false,
	connectionPerTCP:commander.connectionPerTCP||false,
	connectionPerUDP:commander.connectionPerUDP||false,
	connectionForUDP:commander.connectionForUDP||false,
};



/*
options:
	//connections rules (order by priority)
	connectionPerRequest : new connection for every new request
	connectionPerTCP : new connection for each TCP request
	connectionPerUDP : new connection for each UDP request(UDP in separate connections)
	connectionPerTarget : new connection for every different target(port included)
	connectionForUDP : new connection for UDP requests(UDP in one connection)

client names
	default 		(for requests not in the rule)
	X:random 		(for perRequest rule)
	Target:target 	(for perTarget rule)
	TCP:random 		(for perTCP rule)
	UDP:random 		(for perUDP rule)
	UDP 			(for UDP fule)
*/

class dangocoProxyClient{
	constructor(dangocoConfig,proxyConfig){
		this.dangocoConfig=Object.assign({},dangocoConfig);
		this.proxyConfig=Object.assign({},proxyConfig);
		this.clients=new Map();
		//prevent node from exiting
		this._refTimer=setInterval(()=>{},0xFFFFFFF);
	}
	proxy(protocol,addr,port,stream,callback){
		let [clientName,tunnelMode]=this._getClientInfo(protocol,addr,port),
			client=this.clients.get(clientName);

		if(!client){//create a new client if not exists
			console.log('[new client]',clientName);
			client=new dangocoClient({
				mode:tunnelMode,
				addr:this.dangocoConfig.server,
				ws:{
					perMessageDeflate:!commander.disableDeflate,
				},
				idleTimeout:this.dangocoConfig.idle||5*60000,//defaults to 5 minutes
			},{
				udpInTunnel:this.dangocoConfig.udpInTunnel,
				user:this.dangocoConfig.user,
				pass:this.dangocoConfig.pass,
				algo:this.dangocoConfig.algo,
				keyLength:this.dangocoConfig.keyLength,
			});
			client.clientName=clientName;
			client.once('close',()=>{
				this.clients.delete(client.clientName);//remove from client list
				console.log('[close client]',clientName);
			}).on('error',e=>{
				console.error('[tunnel error]',e)
			}).on('proxy_open',info=>{
				console.log('[proxy]',`(${info.type})`,_targetString(info.addr,info.port));
			}).on('proxy_close',info=>{
				if(tunnelMode!=='subStream'){
					client.close();
					this.clients.delete(clientName);
				}
				console.log('[proxy close]',`(${info.type})`,`${_targetString(info.addr,info.port)}`);
			}).on('proxy_error',(info,e)=>{
				console.error('[proxy error]',`(${info.type})`,`${_targetString(info.addr,info.port)}`,(e instanceof Error)?e.message:e)
			});

			client.connectionMng.on('_wserror',(ws,err)=>{
				console.error('connection error:',err.message)
			});

			this.clients.set(clientName,client);
		}
		if(!client.tunnelCreated){
			client.once('tunnel_open',()=>{
				callback(client.proxy(protocol,addr,port,stream));
				return;
			});
		}else{
			callback(client.proxy(protocol,addr,port,stream));
			return;
		}
	}
	_randomName(){//generate a random name value
		return Math.round(Math.random()*544790277504495).toString(32)+'_'+Date.now().toString(32);
	}
	_getClientInfo(protocol,addr,port){//generate the client name
		let name='default',multiConnection=true;
		if(this.proxyConfig.connectionPerRequest){
			name=`X:${this._randomName()}`;
			multiConnection=false;
		}else if(this.proxyConfig.connectionPerTCP && protocol==='tcp'){
			name=`TCP:${this._randomName()}`;
			multiConnection=false;
		}else if(this.proxyConfig.connectionPerUDP && protocol==='udp'){
			name=`UDP:${this._randomName()}`;
			multiConnection=false;
		}else if(this.proxyConfig.connectionPerTarget){
			name=`Target:${addr}@${port}`;
		}else if(this.proxyConfig.connectionForUDP){
			name=`UDP`;
		}
		if(!multiConnection && this.clients.has(name))
			return this._getClientInfo(protocol,addr,port);
		return [name,multiConnection?'subStream':'stream'];//use stream mode for private tunnel,subStream mode for mixed tunnel
	}
}

const proxyClient=new dangocoProxyClient(dangocoConfig,proxyConfig);



/*-------socks server--------*/
let socks5Server,dangocoUDPTools;
if(commander.socksHost || commander.socksPort){
	let host=commander.socksHost||'127.0.0.1',
		port=commander.socksPort||1080;
	initSocksServer(host,port);
}

function relayUDP(socket, port, address, CMD_REPLY){
	proxyClient.proxy('udp',address,port,socket,udpDeliver=>{
		udpDeliver.once('ready',()=>{
			let relay=new socks5Server.UDPRelay(socket, port, address, CMD_REPLY);
			relay.on('clientMessage',frame=>{//msg from client
				dangocoUDPTools.dangocoUDP.socks5ToDangoco(frame);
				udpDeliver.emit('clientMsg',frame);
			});
			udpDeliver.on('remoteMsg',frame=>{
				frame[0]=frame[1]=frame[2]=0x00;
				relay.replyMsg(frame);
			});
		});
	})
}
function initSocksServer(host,port){
	if(!socks5Server)socks5Server=require('socks5server');
	if(!dangocoUDPTools)dangocoUDPTools=require('./lib/udp.js');
	var s5server=global.s5server=socks5Server.createServer();

	s5server.on('tcp',(socket, port, address, CMD_REPLY)=>{
		proxyClient.proxy('tcp',address,port,socket,()=>{
			CMD_REPLY();
		});
	}).on('udp',relayUDP)
	.on('error', function (e) {
		console.error('SERVER ERROR: %j', e);
		if(e.code == 'EADDRINUSE') {
			console.log('Address in use, retrying in 10 seconds...');
			setTimeout(function () {
				console.log('Reconnecting to %s:%s', host, port);
				s5server.close();
				s5server.listen(port, host);
			}, 10000);
		}
	}).on('client_error',(socket,e)=>{
		console.error('  [client error]',`${_domainName(socket.targetAddress)} ${_targetString(socket.remoteAddress,socket.targetPort)}`,e.message);
	}).on('socks_error',(socket,e)=>{
		console.error('  [socks error]',`${_domainName(socket.targetAddress)} ${_targetString(socket.remoteAddress,socket.targetPort)}`,e.message);
	}).on('proxy_error',(proxy,e)=>{
		console.error('  [proxy error]',`${targetAddress(proxy.targetAddress,proxy.targetPort)}`,e.message);
	}).once('close',()=>{
		global.s5server=null;
	}).listen(port, host,()=>{
		console.log('socks server stared');
	});
}

function _domainName(addr){
	return net.isIP(addr)?'':'('+addr+')';
}

function _targetString(addr,port){
	if(addr)return `${addr}:${port}`;
	return 'no target';
}




/*-------IPC control--------*/

if(require('cluster').isWorker){
	var IPCControl=requrie('./lib/IPCControl');
	enableIPCControl();
}
function enableIPCControl(){
	let ctrl=new IPCControl(process);
	ctrl.action('closeSocks',(msg,callback)=>{
		if(global.s5server && !global.s5server.closing){
			global.s5server.closing=true;
			global.s5server.close(()=>{
				callback();
			});
			return;
		}
		callback('socks server is not running');
	}).action('startSocks',msg=>{
		if(global.s5server){
			callback('socks server is running');
			return;
		}
		let host=msg.host||commander.socksHost,
			port=msg.port||commander.socksPort;
		if(host){
			callback('host not defined');
			return;
		}
		if(host){
			callback('port not defined');
			return;
		}
		initSocksServer(host,port);
		callback();
	});
}