window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(window.RTCPeerConnection || window.mozRTCPeerConnection || window.webkitRTCPeerConnection);
if (!crypto.subtle && localStorage.getItem('unsecure_warning') !== 'received') {
    // Warn once per session
    alert("PairDrops functionality to compare received with requested files works in secure contexts only (https or localhost).")
    localStorage.setItem('unsecure_warning', 'received')
}
class ServerConnection {

    constructor() {
        this._connect();
        Events.on('beforeunload', _ => this._disconnect());
        Events.on('pagehide', _ => this._disconnect());
        document.addEventListener('visibilitychange', _ => this._onVisibilityChange());
        if (navigator.connection) navigator.connection.addEventListener('change', _ => this._disconnect());
        Events.on('reconnect', _ => this._reconnect());
        Events.on('room-secrets', e => this._sendRoomSecrets(e.detail));
        Events.on('room-secret-deleted', e => this.send({ type: 'room-secret-deleted', roomSecret: e.detail}));
        Events.on('room-secrets-cleared', e => this.send({ type: 'room-secrets-cleared', roomSecrets: e.detail}));
        Events.on('resend-peers', _ => this.send({ type: 'resend-peers'}));
        Events.on('pair-device-initiate', _ => this._onPairDeviceInitiate());
        Events.on('pair-device-join', e => this._onPairDeviceJoin(e.detail));
        Events.on('pair-device-cancel', _ => this.send({ type: 'pair-device-cancel' }));
        Events.on('offline', _ => clearTimeout(this._reconnectTimer));
        Events.on('online', _ => this._connect());
    }

    async _connect() {
        clearTimeout(this._reconnectTimer);
        if (this._isConnected() || this._isConnecting()) return;
        const ws = new WebSocket(await this._endpoint());
        ws.binaryType = 'arraybuffer';
        ws.onopen = _ => this._onOpen();
        ws.onmessage = e => this._onMessage(e.data);
        ws.onclose = _ => this._onDisconnect();
        ws.onerror = e => this._onError(e);
        this._socket = ws;
    }

    _onOpen() {
        console.log('WS: server connected');
        Events.fire('ws-connected');
    }

    _sendRoomSecrets(roomSecrets) {
        this.send({ type: 'room-secrets', roomSecrets: roomSecrets });
    }

    _onPairDeviceInitiate() {
        if (!this._isConnected()) {
            Events.fire('notify-user', 'You need to be online to pair devices.');
            return;
        }
        this.send({ type: 'pair-device-initiate' })
    }

    _onPairDeviceJoin(roomKey) {
        if (!this._isConnected()) {
            setTimeout(_ => this._onPairDeviceJoin(roomKey), 5000);
            return;
        }
        this.send({ type: 'pair-device-join', roomKey: roomKey })
    }

    _onMessage(msg) {
        msg = JSON.parse(msg);
        if (msg.type !== 'ping') console.log('WS:', msg);
        switch (msg.type) {
            case 'peers':
                Events.fire('peers', msg);
                break;
            case 'peer-joined':
                Events.fire('peer-joined', msg);
                break;
            case 'peer-left':
                Events.fire('peer-left', msg.peerId);
                break;
            case 'signal':
                Events.fire('signal', msg);
                break;
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'display-name':
                this._onDisplayName(msg);
                break;
            case 'pair-device-initiated':
                Events.fire('pair-device-initiated', msg);
                break;
            case 'pair-device-joined':
                Events.fire('pair-device-joined', msg.roomSecret);
                break;
            case 'pair-device-join-key-invalid':
                Events.fire('pair-device-join-key-invalid');
                break;
            case 'pair-device-canceled':
                Events.fire('pair-device-canceled', msg.roomKey);
                break;
            case 'pair-device-join-key-rate-limit':
                Events.fire('notify-user', 'Rate limit reached. Wait 10 seconds and try again.');
                break;
            case 'secret-room-deleted':
                Events.fire('secret-room-deleted', msg.roomSecret);
                break;
            default:
                console.error('WS: unknown message type', msg);
        }
    }

    send(msg) {
        if (!this._isConnected()) return;
        this._socket.send(JSON.stringify(msg));
    }

    _onDisplayName(msg) {
        sessionStorage.setItem("peerId", msg.message.peerId);
        PersistentStorage.get('peerId').then(peerId => {
            if (!peerId) {
                // save peerId to indexedDB to retrieve after PWA is installed
                PersistentStorage.set('peerId', msg.message.peerId).then(peerId => {
                    console.log(`peerId saved to indexedDB: ${peerId}`);
                });
            }
        }).catch(_ => _ => PersistentStorage.logBrowserNotCapable())
        Events.fire('display-name', msg);
    }

    async _endpoint() {
        // hack to detect if deployment or development environment
        const protocol = location.protocol.startsWith('https') ? 'wss' : 'ws';
        const webrtc = window.isRtcSupported ? '/webrtc' : '/fallback';
        let ws_url = new URL(protocol + '://' + location.host + location.pathname + 'server' + webrtc);
        const peerId = await this._peerId();
        if (peerId) ws_url.searchParams.append('peer_id', peerId)
        return ws_url.toString();
    }

    async _peerId() {
        // make peerId persistent when pwa is installed
        return window.matchMedia('(display-mode: minimal-ui)').matches
            ? await PersistentStorage.get('peerId')
            : sessionStorage.getItem("peerId");
    }

    _disconnect() {
        this.send({ type: 'disconnect' });
        this._socket.onclose = null;
        this._socket.close();
        this._socket = null;
        Events.fire('ws-disconnected');
    }

    _onDisconnect() {
        console.log('WS: server disconnected');
        Events.fire('notify-user', 'Connection lost. Retrying...');
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(_ => this._connect(), 1000);
        Events.fire('ws-disconnected');
    }

    _onVisibilityChange() {
        if (document.hidden) return;
        this._connect();
    }

    _isConnected() {
        return this._socket && this._socket.readyState === this._socket.OPEN;
    }

    _isConnecting() {
        return this._socket && this._socket.readyState === this._socket.CONNECTING;
    }

    _onError(e) {
        console.error(e);
    }

    _reconnect() {
        this._disconnect();
        this._connect();
    }
}

class Peer {

    constructor(serverConnection, peerId, roomType, roomSecret) {
        this._server = serverConnection;
        this._peerId = peerId;
        this._roomType = roomType;
        this._roomSecret = roomSecret;
        this._filesQueue = [];
        this._busy = false;
    }

    sendJSON(message) {
        this._send(JSON.stringify(message));
    }

    async createHeader(file) {
        let hashHex = await this.getHashHex(file);
        return {
            name: file.name,
            mime: file.type,
            size: file.size,
            hashHex: hashHex
        };
    }

    async getHashHex(file) {
        if (!crypto.subtle) {
            console.warn("PairDrops functionality to compare received with requested files works in secure contexts only (https or localhost).")
            return;
        }
        const hashBuffer = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        // Convert hex to hash, see https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest#converting_a_digest_to_a_hex_string
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join(''); // convert bytes to hex string
        return(hashHex);
    }

    getResizedImageDataUrl(file, width = undefined, height = undefined, quality = 0.7) {
        return new Promise((resolve) => {
            let image = new Image();
            image.src = URL.createObjectURL(file);
            image.onload = _ => {
                let imageWidth = image.width;
                let imageHeight = image.height;
                let canvas = document.createElement('canvas');

                // resize the canvas and draw the image data into it
                if (width && height) {
                    canvas.width = width;
                    canvas.height = height;
                } else if (width) {
                    canvas.width = width;
                    canvas.height = Math.floor(imageHeight * width / imageWidth)
                } else if (height) {
                    canvas.width = Math.floor(imageWidth * height / imageHeight);
                    canvas.height = height;
                } else {
                    canvas.width = imageWidth;
                    canvas.height = imageHeight
                }

                var ctx = canvas.getContext("2d");
                ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

                let dataUrl = canvas.toDataURL("image/jpeg", quality);
                resolve(dataUrl);
            }
        }).then(dataUrl => {
            return dataUrl;
        })
    }

    async requestFileTransfer(files) {
        Events.fire('set-progress', {peerId: this._peerId, progress: 0, status: 'prepare'})

        let header = [];
        let combinedSize = 0;
        for (let i=0; i<files.length; i++) {
            header.push(await this.createHeader(files[i]));
            combinedSize += files[i].size;
        }
        this._fileHeaderRequested = header;
        let bytesCompleted = 0;

        zipper.createNewZipWriter();
        for (let i=0; i<files.length; i++) {
            const entry = await zipper.addFile(files[i], {
                onprogress: (progress, total) => {
                    Events.fire('set-progress', {
                        peerId: this._peerId,
                        progress: (bytesCompleted + progress) / combinedSize,
                        status: 'prepare'
                    })
                }
            });
            bytesCompleted += files[i].size;
        }
        this.zipFileRequested = await zipper.getZipFile();

        if (files[0].type.split('/')[0] === 'image') {
            this.getResizedImageDataUrl(files[0], 400, null, 0.9).then(dataUrl => {
                this.sendJSON({type: 'request',
                    header: header,
                    size: combinedSize,
                    thumbnailDataUrl: dataUrl
                });
            })
        } else {
            this.sendJSON({type: 'request',
                header: header,
                size: combinedSize,
            });
        }
        Events.fire('set-progress', {peerId: this._peerId, progress: 0, status: 'wait'})
    }

    async sendFiles() {
        console.debug("sendFiles")
        console.debug(this.zipFileRequested);
        this._filesQueue.push({zipFile: this.zipFileRequested, fileHeader: this._fileHeaderRequested});
        this._fileHeaderRequested = null
        if (this._busy) return;
        this._dequeueFile();
    }

    _dequeueFile() {
        if (!this._filesQueue.length) return;
        this._busy = true;
        const file = this._filesQueue.shift();
        this._sendFile(file);
    }

    async _sendFile(file) {
        this.sendJSON({
            type: 'header',
            size: file.zipFile.size,
            fileHeader: file.fileHeader
        });
        this._chunker = new FileChunker(file.zipFile,
            chunk => this._send(chunk),
            offset => this._onPartitionEnd(offset));
        this._chunker.nextPartition();
    }

    _onPartitionEnd(offset) {
        this.sendJSON({ type: 'partition', offset: offset });
    }

    _onReceivedPartitionEnd(offset) {
        this.sendJSON({ type: 'partition-received', offset: offset });
    }

    _sendNextPartition() {
        if (!this._chunker || this._chunker.isFileEnd()) return;
        this._chunker.nextPartition();
    }

    _sendProgress(progress) {
        this.sendJSON({ type: 'progress', progress: progress });
    }

    _onMessage(message) {
        if (typeof message !== 'string') {
            this._onChunkReceived(message);
            return;
        }
        message = JSON.parse(message);
        console.log('RTC:', message);
        switch (message.type) {
            case 'request':
                this._onFilesTransferRequest(message);
                break;
            case 'header':
                this._onFilesHeader(message);
                break;
            case 'partition':
                this._onReceivedPartitionEnd(message);
                break;
            case 'partition-received':
                this._sendNextPartition();
                break;
            case 'progress':
                this._onDownloadProgress(message.progress);
                break;
            case 'files-transfer-response':
                this._onFileTransferRequestResponded(message);
                break;
            case 'file-transfer-complete':
                this._onFileTransferCompleted();
                break;
            case 'message-transfer-complete':
                this._onMessageTransferCompleted();
                break;
            case 'text':
                this._onTextReceived(message);
                break;
        }
    }

    _onFilesTransferRequest(request) {
        if (this._requestPending) {
            // Only accept one request at a time
            this.sendJSON({type: 'files-transfer-response', accepted: false});
            return;
        }
        this._requestPending = true;
        Events.fire('files-transfer-request', {
            request: request,
            peerId: this._peerId
        });
    }

    _respondToFileTransferRequest(header, accepted) {
        this._requestPending = false;
        this._acceptedHeader = header;
        this.sendJSON({type: 'files-transfer-response', accepted: accepted});
        if (accepted) this._busy = true;
    }


    _onFilesHeader(msg) {
        if (JSON.stringify(this._acceptedHeader) === JSON.stringify(msg.fileHeader)) {
            this._lastProgress = 0;
            this._digester = new FileDigester(msg.size, blob => this._onFileReceived(blob, msg.fileHeader));
            this._acceptedHeader = null;
        }
    }

    _onChunkReceived(chunk) {
        if(!this._digester || !(chunk.byteLength || chunk.size)) return;

        this._digester.unchunk(chunk);
        const progress = this._digester.progress;
        this._onDownloadProgress(progress);

        // occasionally notify sender about our progress
        if (progress - this._lastProgress < 0.01) return;
        this._lastProgress = progress;
        this._sendProgress(progress);
    }

    _onDownloadProgress(progress) {
        if (this._busy) {
            Events.fire('set-progress', {peerId: this._peerId, progress: progress, status: 'transfer'});
        }
    }

    async _onFileReceived(zipBlob, fileHeader) {
        Events.fire('set-progress', {peerId: this._peerId, progress: 0, status: 'wait'});
        this._busy = false;
        this.sendJSON({type: 'file-transfer-complete'});

        let zipEntries = await zipper.getEntries(zipBlob);
        let files = [];
        for (let i=0; i<zipEntries.length; i++) {
            let fileBlob = await zipper.getData(zipEntries[i]);
            let hashHex = await this.getHashHex(fileBlob);

            let sameHex = hashHex === fileHeader[i].hashHex;
            let sameSize = fileBlob.size === fileHeader[i].size;
            let sameName = zipEntries[i].filename === fileHeader[i].name
            if (!sameHex || !sameSize || !sameName) {
                Events.fire('notify-user', 'Files are malformed.');
                Events.fire('set-progress', {peerId: this._peerId, progress: 1, status: 'wait'});
                throw new Error("Received files differ from requested files. Abort!");
            }

            files.push(new File([fileBlob], zipEntries[i].filename, {
                type: fileHeader[i].mime,
                lastModified: new Date().getTime()
            }));
        }
        Events.fire('files-received', {sender: this._peerId, files: files});
    }

    _onFileTransferCompleted() {
        this._onDownloadProgress(1);
        this._digester = null;
        this._busy = false;
        this._dequeueFile();
        Events.fire('notify-user', 'File transfer completed.');
    }

    _onFileTransferRequestResponded(message) {
        if (!message.accepted) {
            Events.fire('set-progress', {peerId: this._peerId, progress: 1, status: 'wait'});

            this.zipFile = null;
            return;
        }
        Events.fire('file-transfer-accepted');
        this.sendFiles();
    }

    _onMessageTransferCompleted() {
        Events.fire('notify-user', 'Message transfer completed.');
    }

    sendText(text) {
        const unescaped = btoa(unescape(encodeURIComponent(text)));
        this.sendJSON({ type: 'text', text: unescaped });
    }

    _onTextReceived(message) {
        const escaped = decodeURIComponent(escape(atob(message.text)));
        Events.fire('text-received', { text: escaped, sender: this._peerId });
        this.sendJSON({ type: 'message-transfer-complete' });
    }
}

class RTCPeer extends Peer {

    constructor(serverConnection, peerId, roomType, roomSecret) {
        super(serverConnection, peerId, roomType, roomSecret);
        if (!peerId) return; // we will listen for a caller
        this._connect(peerId, true);
    }

    _connect(peerId, isCaller) {
        if (!this._conn) this._openConnection(peerId, isCaller);

        if (isCaller) {
            this._openChannel();
        } else {
            this._conn.ondatachannel = e => this._onChannelOpened(e);
        }
    }

    _openConnection(peerId, isCaller) {
        this._isCaller = isCaller;
        this._peerId = peerId;
        this._conn = new RTCPeerConnection(RTCPeer.config);
        this._conn.onicecandidate = e => this._onIceCandidate(e);
        this._conn.onconnectionstatechange = _ => this._onConnectionStateChange();
        this._conn.oniceconnectionstatechange = e => this._onIceConnectionStateChange(e);
    }

    _openChannel() {
        const channel = this._conn.createDataChannel('data-channel', {
            ordered: true,
            reliable: true // Obsolete. See https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/reliable
        });
        channel.onopen = e => this._onChannelOpened(e);
        this._conn.createOffer().then(d => this._onDescription(d)).catch(e => this._onError(e));
    }

    _onDescription(description) {
        // description.sdp = description.sdp.replace('b=AS:30', 'b=AS:1638400');
        this._conn.setLocalDescription(description)
            .then(_ => this._sendSignal({ sdp: description }))
            .catch(e => this._onError(e));
    }

    _onIceCandidate(event) {
        if (!event.candidate) return;
        this._sendSignal({ ice: event.candidate });
    }

    onServerMessage(message) {
        if (!this._conn) this._connect(message.sender, false);

        if (message.sdp) {
            this._conn.setRemoteDescription(new RTCSessionDescription(message.sdp))
                .then( _ => {
                    if (message.sdp.type === 'offer') {
                        return this._conn.createAnswer()
                            .then(d => this._onDescription(d));
                    }
                })
                .catch(e => this._onError(e));
        } else if (message.ice) {
            this._conn.addIceCandidate(new RTCIceCandidate(message.ice));
        }
    }

    _onChannelOpened(event) {
        console.log('RTC: channel opened with', this._peerId);
        Events.fire('peer-connected', this._peerId);
        const channel = event.channel || event.target;
        channel.binaryType = 'arraybuffer';
        channel.onmessage = e => this._onMessage(e.data);
        channel.onclose = _ => this._onChannelClosed();
        this._channel = channel;
    }

    _onChannelClosed() {
        console.log('RTC: channel closed', this._peerId);
        Events.fire('peer-disconnected', this._peerId);
        if (!this._isCaller) return;
        this._connect(this._peerId, true); // reopen the channel
    }

    _onConnectionStateChange() {
        console.log('RTC: state changed:', this._conn.connectionState);
        switch (this._conn.connectionState) {
            case 'disconnected':
                this._onChannelClosed();
                break;
            case 'failed':
                this._conn = null;
                this._onChannelClosed();
                break;
        }
    }

    _onIceConnectionStateChange() {
        switch (this._conn.iceConnectionState) {
            case 'failed':
                console.error('ICE Gathering failed');
                Events.fire('reconnect');
                break;
            default:
                console.log('ICE Gathering', this._conn.iceConnectionState);
        }
    }

    _onError(error) {
        console.error(error);
        Events.fire('reconnect');
    }

    _send(message) {
        if (!this._channel) return this.refresh();
        this._channel.send(message);
    }

    _sendSignal(signal) {
        signal.type = 'signal';
        signal.to = this._peerId;
        signal.roomType = this._roomType;
        signal.roomSecret = this._roomSecret;
        this._server.send(signal);
    }

    refresh() {
        // check if channel is open. otherwise create one
        console.debug("refresh:");
        console.debug(this._conn);
        if (this._isConnected() || this._isConnecting()) return;
        this._connect(this._peerId, this._isCaller);
    }

    _isConnected() {
        return this._channel && this._channel.readyState === 'open';
    }

    _isConnecting() {
        return this._channel && this._channel.readyState === 'connecting';
    }
}

class WSPeer extends Peer {
    _send(message) {
        message.to = this._peerId;
        message.roomType = this._roomType;
        message.roomSecret = this._roomSecret;
        this._server.send(message);
    }
}

class PeersManager {

    constructor(serverConnection) {
        this.peers = {};
        this._server = serverConnection;
        Events.on('signal', e => this._onMessage(e.detail));
        Events.on('peers', e => this._onPeers(e.detail));
        Events.on('files-selected', e => this._onFilesSelected(e.detail));
        Events.on('respond-to-files-transfer-request', e => this._onRespondToFileTransferRequest(e.detail))
        Events.on('send-text', e => this._onSendText(e.detail));
        Events.on('peer-joined', e => this._onPeerJoined(e.detail));
        Events.on('peer-left', e => this._onPeerLeft(e.detail));
        Events.on('ws-disconnected', _ => this._clearPeers());
        Events.on('secret-room-deleted', e => this._onSecretRoomDeleted(e.detail));
    }

    _onMessage(message) {
        this._refreshOrCreatePeer(message.sender, message.roomType, message.roomSecret);
        this.peers[message.sender].onServerMessage(message);
    }

    _refreshOrCreatePeer(id, roomType, roomSecret) {
        if (!this.peers[id]) {
            this.peers[id] = new RTCPeer(this._server, undefined, roomType, roomSecret);
        }else if (this.peers[id]._roomType !== roomType) {
            this.peers[id]._roomType = roomType;
            this.peers[id]._roomSecret = roomSecret;
        }
    }

    _onPeers(msg) {
        msg.peers.forEach(peer => {
            if (this.peers[peer.id]) {
                if (this.peers[peer.id].roomType === msg.roomType) {
                    this.peers[peer.id].refresh();
                } else {
                    this.peers[peer.id].roomType = msg.roomType;
                    this.peers[peer.id].roomSecret = msg.roomSecret;
                }
                return;
            }
            if (window.isRtcSupported && peer.rtcSupported) {
                this.peers[peer.id] = new RTCPeer(this._server, peer.id, msg.roomType, msg.roomSecret);
            } else {
                this.peers[peer.id] = new WSPeer(this._server, peer.id, msg.roomType, msg.roomSecret);
            }
        })
    }

    sendTo(peerId, message) {
        this.peers[peerId].send(message);
    }

    _onRespondToFileTransferRequest(detail) {
        this.peers[detail.to]._respondToFileTransferRequest(detail.header, detail.accepted);
    }

    _onFilesSelected(message) {
        const files = this._addTypeIfMissing(message.files);
        this.peers[message.to].requestFileTransfer(files);
    }

    _addTypeIfMissing(files) {
        let filesWithType = [], file;
        for (let i=0; i<files.length; i++) {
            // when filename is empty guess via suffix
            file = files[i].type
                ? files[i]
                : new File([files[i]], files[i].name, {type: mime.getMimeByFilename(files[i].name)});
            filesWithType.push(file)
        }
        return filesWithType;
    }

    _onSendText(message) {
        this.peers[message.to].sendText(message.text);
    }

    _onPeerJoined(message) {
        this._onMessage({sender: message.peer.id, roomType: message.roomType, roomSecret: message.roomSecret});
    }

    _onPeerLeft(peerId) {
        const peer = this.peers[peerId];
        delete this.peers[peerId];
        if (!peer || !peer._conn) return;
        if (peer._channel) peer._channel.onclose = null;
        peer._conn.close();
    }

    _clearPeers() {
        if (this.peers) {
            Object.keys(this.peers).forEach(peerId => this._onPeerLeft(peerId));
        }
    }

    _onSecretRoomDeleted(roomSecret) {
        for (const peerId in this.peers) {
            const peer = this.peers[peerId];
            if (peer._roomSecret === roomSecret) {
                this._onPeerLeft(peerId);
            }
        }
    }
}

class FileChunker {

    constructor(file, onChunk, onPartitionEnd) {
        this._chunkSize = 64000; // 64 KB
        this._maxPartitionSize = 1e6; // 1 MB
        this._offset = 0;
        this._partitionSize = 0;
        this._file = file;
        this._onChunk = onChunk;
        this._onPartitionEnd = onPartitionEnd;
        this._reader = new FileReader();
        this._reader.addEventListener('load', e => this._onChunkRead(e.target.result));
    }

    nextPartition() {
        this._partitionSize = 0;
        this._readChunk();
    }

    _readChunk() {
        const chunk = this._file.slice(this._offset, this._offset + this._chunkSize);
        this._reader.readAsArrayBuffer(chunk);
    }

    _onChunkRead(chunk) {
        this._offset += chunk.byteLength;
        this._partitionSize += chunk.byteLength;
        this._onChunk(chunk);
        if (this.isFileEnd()) return;
        if (this._isPartitionEnd()) {
            this._onPartitionEnd(this._offset);
            return;
        }
        this._readChunk();
    }

    repeatPartition() {
        this._offset -= this._partitionSize;
        this.nextPartition();
    }

    _isPartitionEnd() {
        return this._partitionSize >= this._maxPartitionSize;
    }

    isFileEnd() {
        return this._offset >= this._file.size;
    }

    get progress() {
        return this._offset / this._file.size;
    }
}

class FileDigester {

    constructor(size, callback) {
        this._buffer = [];
        this._bytesReceived = 0;
        this._size = size;
        this._callback = callback;
    }

    unchunk(chunk) {
        this._buffer.push(chunk);
        this._bytesReceived += chunk.byteLength || chunk.size;
        this.progress = this._bytesReceived / this._size;
        if (isNaN(this.progress)) this.progress = 1

        if (this._bytesReceived < this._size) return;
        // we are done
        this._callback(new Blob(this._buffer));
    }

}

class Events {
    static fire(type, detail) {
        window.dispatchEvent(new CustomEvent(type, { detail: detail }));
    }

    static on(type, callback) {
        return window.addEventListener(type, callback, false);
    }

    static off(type, callback) {
        return window.removeEventListener(type, callback, false);
    }
}

RTCPeer.config = {
    'sdpSemantics': 'unified-plan',
    'iceServers': [
        {
            urls: 'stun:stun.l.google.com:19302'
        },
        {
            urls: 'stun:openrelay.metered.ca:80'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject',
        },
    ]
}
