'use strict';

/**
 * This is a minimal example where I wanted to use the WebRTC recording feature to transmit a video stream via
 * websockets from a streamer to one or several receivers.
 * 
 * As most WebRTC samples suggest to use websockets for signaling between two peers I wanted to reuse that service
 * for also transmitting the data. The goal was to only have one server instead of two (one signaling and one
 * for working around NAT).
 * 
 * So how does this example work? The streamer creates a MediaRecorder with the stream to record as the argument.
 * The recording is started after a call to the start method. The start method in my code takes a time in milliseconds
 * as an argument. This time is the time of a recording before it is given to the event handler ondataavailable.
 * Please note you can't go below between a certain value (50 is slightly above it but I haven't tried to go down
 * to the exact value). Using higher numbers would add too much delay to the video stream and users would get
 * irritated.
 * The video data provided in ondataavailable are a blob. To get from a blob to bytes a FileReader is needed. But
 * having the bytes is not enough. You can't send binary data over websockets and the size of a message is limited
 * to 64K. So an encoding and chunking is needed. As the built in base64 econdoder had some issues that generated
 * too large chunks that weren't converted back correctly. So I've created my own encoder and decoder. The chunking
 * is a simple array slicing with a boolean flag to indicate the last chunk.
 * 
 * The receiver needs a MediaSource to get a sourceBuffer via mediaSource.addSourceBuffer. But the Method addSourceBuffer
 * after the MediaSource has signaled via sourceopen that it is open. As the sourceBuffer can only process complete
 * video chunks the transport chunks need to be collected and reassembled. Adding the video chunks directly to
 * the sourceBuffer worked most of the time but not always. I've found some code on the Internet that added another
 * queue that was used when the sourceBuffer was updating. Thus there are two places in the code where I add
 * video data to the sourceBuffer.
 * 
 * Please note the codec that is given as an argument to mediaSource.addSourceBuffer. While Firefox is pretty relaxed
 * about it Chromium will run havoc when the string isn't exactly as it expects it.
 * Another part is that currently cross browser streaming doesn't work. Both parties need to use the same browser.
 * 
 * Another constraint of this program is that users can't join an already started stream. MediaRecorder uses a container
 * format that contain some important information in the first block.
 */


/**
 * Handles the entry page where the user decides if he/she wants to be streamer or receiver.
 */
class MainWindow {
	init() {
		document.getElementById('createRoom').onclick=()=>this.createRoom();
		document.getElementById('joinRoom').onclick=()=>this.joinRoom();
	}
	
	/**
	 * Opens the page for the streamer.
	 */
	createRoom() {
		new StreamVideo().init();
	}
	
	/**
	 * Opens the page for the receiver.
	 */
	joinRoom() {
		let roomKey = document.getElementById('roomKey').value.trim();
		let user = document.getElementById('username').value;
		new ReceiveVideo(roomKey, user).init();
	}
}

/**
 * Base class for streamer and receiver.
 */
class VideoBase {
	constructor() {
		this.base64 = new Base64();
	}
	
	/**
	 * Loads the page identified by templateId and shows it in the workspace element.
	 */
	initWorkspace(templateId) {
		let template = document.getElementById(templateId).content;
		var clone = document.importNode(template,true);
		let workspace = document.getElementById('workspace')
		workspace.innerHTML='';
		workspace.appendChild(clone);
	}
	
	/**
	 * Creates and returns a websocket to the host of the page. Also adds an error handler.
	 */
	createWebsocket() {
		let webSocket = new WebSocket('ws://'+location.host+'/api/signal');
		webSocket.onerror = (event)=>{
            console.log('onerror::' + JSON.stringify(event, null, 4));
        };
        return webSocket;
	}
	
	/**
	 * Show the Closed page.
	 */
	showClosed() {
		let workspace = document.getElementById('workspace');
		workspace.innerHTML='Closed';
	}
	
    /**
     * Send a message via the websocket. Includes some error handling.
     */
    send(message) {
        if (this.webSocket.readyState == WebSocket.OPEN) {
            this.webSocket.send(message);
        } else {
            console.error('webSocket is not open. readyState=' + this.webSocket.readyState);
        }
    }
}

/**
 * This class implements the logic for the streaming page.
 */
class StreamVideo extends VideoBase {
	constructor() {
		super();
	}
	
	/**
	 * Initializes the page.
	 */
	init() {
		this.initWorkspace('streamerTemplate');
		document.getElementById('startStream').onclick=()=>this.startStreaming();
		document.getElementById('stopStream').onclick=()=>this.stopStreaming();
		this.webSocket = this.createWebsocket();
		this.webSocket.onopen = (event)=>this.initRoom();
        this.webSocket.onclose = (event)=>this.onClose(event);
        this.webSocket.onmessage = (event)=>this.onMessage(event);
	}
	
	/**
	 * Create a room to join for the receiver once the websocket connection is established.
	 */
	initRoom() {
		let createRoomSignal = {operation:'CreateRoom'};
		this.send(JSON.stringify(createRoomSignal));
	}
	
	/**
	 * Called when the websocket is closed. Stops streaming and shows closed page.
	 */
	onClose(event) {
		this.stopStreaming();
		this.showClosed();
	}
	
	/**
	 * Handles the websocket messages send from the server.
	 */
	onMessage(event) {
		let signalResponse = JSON.parse(event.data);
		if (signalResponse.operation==='CreatedRoom') {
			this.createdRoom(signalResponse.payload);
		} else if (signalResponse.operation==='JoindedRoom') {
			this.userJoinded(signalResponse.payload);
		} else {
			console.log(event);
		}
	}
	
	/**
	 * Called when the room was created on the server. Gets the key as argument
	 * and shows it to the user.
	 */
	createdRoom(roomKey) {
		document.getElementById('roomKey').innerHTML='Room key: '+roomKey;
		this.roomKey = roomKey;
	}
	
	/**
	 * Called when the receiver joins the room. Displays the user name.
	 */
	userJoinded(user) {
		let alreadyJoined = document.getElementById('joinded').innerHTML;
		if (alreadyJoined.length>0) {
			alreadyJoined+='<br>';
		}
		alreadyJoined+='User '+user+' joined.';
		document.getElementById('joinded').innerHTML = alreadyJoined;
	}
	
	/**
	 * Called when the user presses the start stream button. Requests access to the webcam
	 * and tries to send video recordings to the receivers via the websocket.
	 */
	startStreaming() {
		let constraints = {
		        'audio': true,
		        'video': true
		    };
		navigator.mediaDevices.getUserMedia(constraints).then(stream => {
			this.mediaRecorder = new MediaRecorder(stream);
			this.mediaRecorder.ondataavailable = streamEvent => {
	            let reader = new FileReader();
	            reader.addEventListener("loadend", () => {
	                let arr = new Uint8Array(reader.result);
	                let start = 0;
	                let batchSize = 40000;
	                while(arr.length>start+batchSize) {
	                	let subArr = arr.slice(start,start+batchSize);
	                	this.sendStreamData(subArr,false);
		                start += batchSize;
	                }
                	let subArr = arr.slice(start);
                	this.sendStreamData(subArr,true);
	            });
	            reader.readAsArrayBuffer(streamEvent.data);
	        };
	        this.mediaRecorder.start(50);
	    }).catch(function (error) {
	        console.log(error)
		});
	}
	
	/**
	 * Send the data in subArr via websocket to the receiver. The lastFlag indicates if this
	 * array is the last part of a video chunk.
	 */
	sendStreamData(subArr,lastFlag) {
		let payloadObject = {roomKey:this.roomKey,videoData:this.base64.encode(subArr),last:lastFlag};
        let streamSignal = {operation:'StreamData',payload:JSON.stringify(payloadObject)};
        let message = JSON.stringify(streamSignal);
        this.send(message);
	}
	
	/**
	 * Callback for the stop streaming button. Stops the recording of the media tracks.
	 */
	stopStreaming() {
		this.mediaRecorder.stop();
		this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
	}
}

/**
 * This class implements the logic for the receiving page.
 */
class ReceiveVideo extends VideoBase {
	/**
	 * Creates a new instance with the room key and the user name from the entry page.
	 */
	constructor(roomKey, user) {
		super();
		this.roomKey = roomKey;
		this.user = user;
		this.chunks = [];
		this.sourceBuffer = null;
		this.queue = [];
	}
	
	/**
	 * Initializes the page.
	 */
	init() {
		this.initWorkspace('receiverTemplate');
		this.webSocket = this.createWebsocket();
		this.webSocket.onopen = (event)=>this.initVideo();
        this.webSocket.onclose = (event)=>this.onClose(event);
        this.webSocket.onmessage = (event)=>this.onMessage(event);
	}
	
	/**
	 * Called after the websocket is initialized. Initializes the MediaSource for the video
	 * tag to show the sender video.
	 */
	initVideo() {
		let payload = JSON.stringify({key:this.roomKey,username:this.user});
		let initStreamSignal = {operation:'JoinRoom',payload:payload};
		this.send(JSON.stringify(initStreamSignal));
		let mediaSource = new MediaSource();
		let video = document.getElementById('video');
		video.src = window.URL.createObjectURL(mediaSource);
		mediaSource.addEventListener('sourceopen', e => {
	        this.sourceBuffer = mediaSource.addSourceBuffer('video/webm;codecs="opus,vp8"');//'video/webm; codecs="vorbis,vp9"'
	        this.sourceBuffer.addEventListener('update', () => {
	        	if (this.queue.length > 0 && !this.sourceBuffer.updating) {
	        		this.sourceBuffer.appendBuffer(this.queue.shift());
	        	}
	        });
			let playPromise = video.play();
			playPromise.catch(event => console.log(event.name+","+event.message));
	    }, false);
	}
	
	/**
	 * Called with stream data from the sender. Collects them in this.chunks
	 * until a complete video portion is received and then adds them either to
	 * the sourceBuffer directly or to a queue when the sourceBuffer is updating.
	 */
	receiveStream(streamDataString) {
		if (this.sourceBuffer==null) {
			return;
		}
		let streamData = JSON.parse(streamDataString);
		let decodedVideoData = this.base64.decode(streamData.videoData);
		this.chunks.push(decodedVideoData);
		if (streamData.last) {
			let decodedData = this.chunks.flat();
			let arr = new Uint8Array(decodedData);
			if (this.sourceBuffer.updating || this.queue.length > 0) {
				this.queue.push(arr);
		    } else {
		    	this.sourceBuffer.appendBuffer(arr);
		    }
			this.chunks=[];
		}
	}
	
	/**
	 * Called when the websocket is closed. Shows the closed page.
	 */
	onClose(event) {
		this.showClosed();
	}
	
	/**
	 * Handles the websocket messages send from the server.
	 */
	onMessage(event) {
		let signalResponse = JSON.parse(event.data);
		if (signalResponse.operation==='StreamData') {
			this.receiveStream(signalResponse.payload);
		} else {
			console.log(event);
		}
	}
}

/**
 * Custom implementation for converting Uint8Array to base64 and back.
 */
class Base64 {
	constructor() {
		this.table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
		this.lookup = [];
		for(let i=0;i<this.table.length;i++) {
			this.lookup[this.table[i]]=i;
		}
	}
	
	/**
	 * Expects a Uint8Array array and returns the base64 encoding as a string.
	 */
	encode(arr) {
		let encodingResult = [];
		for(let i=0;(i+2)<arr.length;i+=3) {
			encodingResult.push(this.table[((arr[i]&0xFC)>>2)]);
			encodingResult.push(this.table[((arr[i]&0x03)<<4)+((arr[i+1]&0xF0)>>4)]);
			encodingResult.push(this.table[((arr[i+1]&0x0F)<<2)+((arr[i+2]&0xC0)>>6)]);
			encodingResult.push(this.table[(arr[i+2]&0x3F)]);
		}
		let remaining = arr.length-encodingResult.length/4*3;
		if (remaining==1) {
			let i=arr.length-1;
			encodingResult.push(this.table[((arr[i]&0xFC)>>2)]);
			encodingResult.push(this.table[((arr[i]&0x03)<<4)]);
			encodingResult.push('=');
			encodingResult.push('=');
		}
		if (remaining==2) {
			let i=arr.length-2;
			encodingResult.push(this.table[((arr[i]&0xFC)>>2)]);
			encodingResult.push(this.table[((arr[i]&0x03)<<4)+((arr[i+1]&0xF0)>>4)]);
			encodingResult.push(this.table[((arr[i+1]&0x0F)<<2)]);
			encodingResult.push('=');
		}
		return encodingResult.join('');
	}
	
	/**
	 * Expects a base64 encoded string and returns a Uint8Array
	 */
	decode(arr) {
		let decodingResult = [];
		let arrLength = arr.length;
		if (arr[arrLength-1] == '=') {
			arrLength -= 4;
		}
		for(let i=0;i<arrLength;i+=4) {
			let val1 = this.lookup[arr[i]];
			let val2 = this.lookup[arr[i+1]];
			let val3 = this.lookup[arr[i+2]];
			let val4 = this.lookup[arr[i+3]];
			decodingResult.push(((0xFF&val1)<<2)+((0xFF&val2)>>4));
			decodingResult.push(((0x0F&val2)<<4)+((0xFF&val3)>>2));
			decodingResult.push(((0x03&val3)<<6)+(0xFF&val4));
		}
		if (arr[arr.length-2] == '=') {
			let i = arrLength;
			let val1 = this.table.indexOf(arr[i]);
			let val2 = this.table.indexOf(arr[i+1]);
			decodingResult.push(((0xFF&val1)<<2)+((0xFF&val2)>>4));
		} else if (arr[arr.length-1] == '=') {
			let i = arrLength;
			let val1 = this.table.indexOf(arr[i]);
			let val2 = this.table.indexOf(arr[i+1]);
			let val3 = this.table.indexOf(arr[i+2]);
			decodingResult.push(((0xFF&val1)<<2)+((0xFF&val2)>>4));
			decodingResult.push(((0x0F&val2)<<4)+((0xFF&val3)>>2));
		}
		return decodingResult;
	}
}

new MainWindow().init();
