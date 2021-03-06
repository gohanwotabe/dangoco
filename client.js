#!/usr/bin/env node
/*
dangoco-node.js client

Copyright 2017 dangoco
*/
'use strict';

const commander = require('commander');
	
commander
	.usage('[options]')
	.version(`dangoco version: ${require('./package.json').version}`)
	//server options
	.option('-s, --server [value]', 'server address. example: ws://127.0.0.1:80')
	.option('-u, --user [value]', 'username')
	.option('-p, --pass [value]', 'password')
	.option('--keyLength', 'set the byteLength of ramdon key(for encryption),max is 128. default: 33',Number)
	//socks options
	.option('--socksHost [value]', 'listen on the host for socks proxy. example: 127.0.0.1')
	.option('--socksPort <n>', 'listen on the port for socks proxy. example: 1080',Number)
	//connections options
	.option('-a, --algo [value]', 'encryption algorithm,defaults to undefined. This should only be set in the insecurity connection')
	.option('--algolist', 'list all available algorithms')
	.option('-I, --idle <n>', 'idleTimeout,the connection will be automatically close after this idle seconds. Defaults to 15.',Number)
	////.option('--udpInTunnel', 'deliver udp packet in tunnel',)
	.option('--disable-deflate', 'disable websocket deflate')
	.option('--keepBrokenTunnel <n>', 'seconds for not closing the tunnel when connection lost.(for bad network conditions)',Number)
	.option('--connectionPerRequest', 'create a connection for every request')
	.option('--connectionPerTarget', 'create a connection for every target')
	.option('--connectionPerTCP', 'create a connection for every tcp request')
	.option('--connectionPerUDP', 'create a connection for every udp request')
	.option('--connectionForUDP', 'create a connection for all udp request')
	//other
	.option('-v', 'display the version')
	.option('-L', 'display connection logs')
	.parse(process.argv);

//--algolist
if(commander.algolist){//list all available algorithms
	console.log(require('crypto').getCiphers().join('\n'));
	return;
}

/*ーーーーーstart of the clientーーーーー*/
const Log=commander.L;//log switch

//prevent node from exiting
setInterval(()=>{},0xFFFFF);

process.on('uncaughtException',function(e){//prevent client from stoping when uncaughtException occurs
	console.error(e);
});


/*-------------dangoco client proxy--------------*/
const net = require('net'),
	byteSize = require('byte-size'),
	{dangocoClient}=require('./lib/client.js');

class ProxyList{
	constructor(){
		this.map=new Map();
		this.list=[];
	}
	set(key,value){
		this.map.set(key,value);
		this.list=[...this.map.values()];
	}
	delete(key){
		this.map.delete(key);
		this.list=[...this.map.values()];
	}
	clear(){
		this.map.clear();
		this.list.length=0;
	}
	first(){
		return this.list[0]||false;
	}
	random(){
		return this.list[((this.list.length-1)*Math.random()+.5)|0]||false;
	}
}


let clientProxyList=new ProxyList(),socksServers=new Map();


const dangocoConfig={
	server:commander.server,
	user:commander.user,
	pass:commander.pass,
	algo:commander.algo,
	idle:commander.idle>=0?commander.idle:15,//defaults to 15s
	keyLength:commander.keyLength||33,
	keepBrokenTunnel:commander.keepBrokenTunnel,
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

class dangocoClientProxy{
	constructor(dangocoConfig,proxyConfig){
		console.log('init proxy client');
		this.dangocoConfig=Object.assign({},dangocoConfig);
		this.proxyConfig=Object.assign({},proxyConfig);
		this.clients=new Map();

	}
	proxy(protocol,addr,port,stream,callback){
		let [clientName,tunnelMode]=this._getClientInfo(protocol,addr,port),
			client=this.clients.get(clientName);

		if(!client){//create a new client if not exists
			Log&&console.log('[new client]',clientName);
			client=new dangocoClient({
				mode:tunnelMode,
				addr:this.dangocoConfig.server,
				ws:{
					perMessageDeflate:!commander.disableDeflate,
				},
				keepBrokenTunnel:this.dangocoConfig.keepBrokenTunnel*1000,//to milliseconds
				idleTimeout:this.dangocoConfig.idle*1000,//to milliseconds
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
				Log&&console.log('[close client]',clientName);
			}).on('error',e=>{
				Log&&console.error('[tunnel error]',e)
			}).on('proxy_open',info=>{
				Log&&console.log('[proxy]',`(<-> ${this.calcConnection()})`,`(${info.type})`,_targetString(info.addr,info.port));
			}).on('proxy_close',info=>{
				if(tunnelMode!=='subStream'){
					client.close();
					this.clients.delete(clientName);
				}
				if(Log){
					let io=info.tunnelStream?{in:info.tunnelStream.agent.in,out:info.tunnelStream.agent.out}:{in:0,out:0};
					let inSize=byteSize(io.in),
						outSize=byteSize(io.out);
					Log&&console.log('[proxy close]',`(<-> ${this.calcConnection()})`,`(${info.type})`,`[↑${outSize.value}${outSize.unit},↓${inSize.value}${inSize.unit} life:${formatTime((Date.now()-info.tunnelStream.agent.time)/1000)}]`,`${_targetString(info.addr,info.port)}`);
				}
			}).on('proxy_error',(info,e)=>{
				Log&&console.error('[proxy error]',`(${info.type})`,`${_targetString(info.addr,info.port)}`,(e instanceof Error)?e.message:e)
			});

			client.connectionMng.on('_wserror',(ws,err)=>{
				Log&&console.error('connection error:',err.message)
			});

			this.clients.set(clientName,client);
		}

		client.proxy(protocol,addr,port,stream,callback);
	}
	calcConnection(){
		let c=0;
		for(let [n,client] of this.clients){
			c+=client.proxyList.size;
		}
		return c;
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
	close(code=1000,reason='Closing proxy'){
		for(let [n,c] of this.clients){
			c.close(code,reason);
		}
	}
}
if(commander.server){
	clientProxyList.set('default',new dangocoClientProxy(dangocoConfig,proxyConfig));
}









/*-------socks server--------*/
let socks5Server,dangocoUDPTools,pump;
/*
socks to client map type
	default : select the first client in the list
	rule : depend on the rule
	name : depend on the name
	random : random

options 
	map:{
		type: map type,
		name: proxy name if type is 'name'
		rule: proxy name if type is 'rule'
	}

*/

class socksProxyServer{
	constructor(host,port,options={}){
		this.options=Object.assign({},options)
		this.name=`${host}:${port}`;
		if(socksServers.has(this.name)){
			throw(Error('duplicated socks server name: '+this.name));
		}
		socksServers.set(this.name,this);

		if(!socks5Server)socks5Server=require('socks5server');
		if(!dangocoUDPTools)dangocoUDPTools=require('./lib/udp.js');
		if(!pump)pump=require('pump');
		const server=this.server=socks5Server.createServer();

		server.on('tcp',(socket, port, address, CMD_REPLY)=>{
			this.relay('tcp',socket, port, address, CMD_REPLY);
		}).on('udp',(socket, port, address, CMD_REPLY)=>{
			this.relay('udp',socket, port, address, CMD_REPLY);
		})
		.on('error', function (e) {
			console.error('SERVER ERROR: %j', e);
			if(e.code == 'EADDRINUSE') {
				console.log('Address in use, retrying in 10 seconds...');
				setTimeout(function () {
					console.log('Reconnecting to %s:%s', host, port);
					server.close();
					server.listen(port, host);
				}, 10000);
			}
		}).on('client_error',(socket,e)=>{
			Log&&console.error('  [client error]',`[${_domainName(socket.targetAddress)} ${_targetString(socket.targetAddress,socket.targetPort)}]`,e.message);
		}).on('socks_error',(socket,e)=>{
			Log&&console.error('  [socks error]',`[${_domainName(socket.targetAddress)} ${_targetString(socket.remoteAddress,socket.targetPort)}]`,e.message);
		}).on('proxy_error',(proxy,e)=>{
			Log&&console.error('  [proxy error]',`[${targetAddress(proxy.targetAddress,proxy.targetPort)}]`,e.message);
		}).once('close',()=>{
			console.log('socks server stoped',this.name);
			socksServers.delete(this.name);
		}).listen(port, host,()=>{
			console.log('socks server stared',this.name);
		});
	}
	relay(type,socket, port, address, CMD_REPLY){
		let proxy=this.dangocoProxy;
		if(proxy===false){
			CMD_REPLY(0x01);
			console.error('No available client proxy');
			return;
		}

		if(type==='tcp'){
			proxy.proxy('tcp',address,port,socket,(err,stream)=>{
				if(!err)
					CMD_REPLY();
				else
					CMD_REPLY(0x01);
			});
		}else if(type==='udp'){
			proxy.proxy('udp',address,port,socket,(err,udpDeliver)=>{
				if(err)return CMD_REPLY(0x01);
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
			});
		}
	}

	get dangocoProxy(){
		let dP;
		switch(this.options.map.type){
			case 'default':{dP=clientProxyList.first();break;}
			case 'random':{dP=clientProxyList.random();break;}
			case 'name':{dP=clientProxyList.map.get(this.options.map.name)||false;break;}
			case 'rule':{
				//todo
				break;
			}
		}
		return dP;
	}
}
function _domainName(addr){
	return (!addr||net.isIP(addr))?'':'('+addr+')';
}
function _targetString(addr,port){
	if(addr)return `${addr}:${port}`;
	return 'unknown target';
}
function formatTime(sec,total=sec){
	sec|=sec;
	let r,
		s=sec|0,
		h=(s/3600)|0;
	if(total>=3600)s=s%3600;
	r=[String((s/60)|0).padStart(2,'0'),String(s%60).padStart(2,'0')];
	(total>=3600)&&r.unshift(String(h).padStart(2,'0'));
	return r.join(':');
}

if(commander.socksHost || commander.socksPort){
	let host=commander.socksHost||'127.0.0.1',
		port=commander.socksPort||1080;
	new socksProxyServer(host,port,{map:{
		type:'default',
	}});
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