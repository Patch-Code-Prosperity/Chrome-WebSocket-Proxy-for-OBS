let obsSocket = null;

let connectionStatus = {
    chromeWebSocket: 'disconnected',
    obsWebSocket: 'disconnected'
};

let messageStats = {
    received: 0,
    forwarded: 0,
    sent: 0,
    lost: 0
};

let obsStats = {
    scenes: 0,
    sources: 0,
    streaming: false,
    recording: false
};

let latestStatus = {
    connectionStatus: connectionStatus,
    messageStats: messageStats,
    obsStats: obsStats
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch(request.action) {
        case "getStatus":
            sendResponse({
                connectionStatus: connectionStatus,
                messageStats: messageStats,
                obsStats: obsStats
            });
            break;
        case "connectObs":
            connectToObs();
            sendResponse({success: true});
            break;
        case "disconnectObs":
            disconnectFromObs();
            sendResponse({success: true});
            break;
    }
    return true;  // Indicates that the response is sent asynchronously
});

chrome.action.onClicked.addListener((tab) => {
    connectToChromeWebSocket(tab.id);
    connectToObs(); // You might want to make this optional or triggered separately
});

function onWebSocketEvent(debuggeeId, message, params) {
    if (message === "Network.webSocketFrameReceived") {
        console.log("WebSocket Frame Received:", params.response.payloadData);
        messageStats.received++;
        // Here you would process and potentially forward the message to OBS
    } else if (message === "Network.webSocketFrameSent") {
        console.log("WebSocket Frame Sent:", params.request.payloadData);
        messageStats.sent++;
    }
    
    updateStatus('chromeWebSocket', 'connected'); // Ensure status stays updated
}

function connectToObs() {
    chrome.storage.sync.get(['forwardUrl'], function(result) {
        const forwardUrl = result.forwardUrl || 'ws://localhost:4455';
        
        console.log('Attempting to connect to OBS WebSocket at:', forwardUrl);
        
        if (obsSocket && obsSocket.readyState === WebSocket.OPEN) {
            console.log('Already connected to OBS WebSocket');
            return;
        }
        
        obsSocket = new WebSocket(forwardUrl);
        
        obsSocket.onopen = () => {
            console.log('OBS WebSocket connection opened');
            updateStatus('obsWebSocket', 'connected');
            // Send the Identify message here, after the connection is open
            const identifyPayload = {
                op: 1,
                d: {
                    rpcVersion: 1,
                    eventSubscriptions: 0
                }
            };
            console.log('Sending Identify message');
            console.log('Identify payload:', JSON.stringify(identifyPayload));
            obsSocket.send(JSON.stringify(identifyPayload));
        };
        
        obsSocket.onerror = (error) => {
            console.error('OBS WebSocket Error:', error);
            updateStatus('obsWebSocket', 'error');
        };

        obsSocket.onclose = (event) => {
            console.log('Disconnected from OBS WebSocket. Code:', event.code, 'Reason:', event.reason);
            updateStatus('obsWebSocket', 'disconnected');
        };

        obsSocket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            console.log('Received message from OBS:', message);
            handleOBSMessage(message);
        };
    });
}

function handleOBSMessage(message) {
    switch (message.op) {
        case 0: // Hello
            console.log('Received Hello message:', message.d);
            // We don't need to send Identify here anymore
            break;
        case 2: // Identified
            console.log('Identified successfully with OBS');
            updateStatus('obsWebSocket', 'authenticated');
            getOBSStats();
            break;
        case 3: // Identification failed
            console.error('Identification failed:', message.d.error);
            updateStatus('auth_failed');
            break;
        case 7: // Request response
            handleOBSResponse(message);
            break;
        default:
            console.log('Unhandled message type:', message.op);
    }
}

function handleHello(helloData) {
    console.log('Received Hello message:', helloData);
    const { rpcVersion } = helloData;
    identifyToObs(rpcVersion);
}

function identifyToObs(rpcVersion) {
    console.log('Sending Identify message');
    const identifyPayload = {
        op: 1,
        d: {
            rpcVersion: rpcVersion,
            eventSubscriptions: 0
        }
    };
    console.log('Identify payload:', JSON.stringify(identifyPayload));
    obsSocket.send(JSON.stringify(identifyPayload));
}

function handleOBSResponse(message) {
    console.log('Received response from OBS:', message);
    if (message.d && message.d.requestType) {
        switch (message.d.requestType) {
            case 'GetSceneList':
                if (message.d.responseData && message.d.responseData.scenes) {
                    obsStats.scenes = message.d.responseData.scenes.length;
                    console.log('Updated scenes count:', obsStats.scenes);
                }
                break;
            case 'GetInputList':
                if (message.d.responseData && message.d.responseData.inputs) {
                    obsStats.sources = message.d.responseData.inputs.length;
                    console.log('Updated sources count:', obsStats.sources);
                }
                break;
            case 'GetStreamStatus':
                if (message.d.responseData && message.d.responseData.outputActive !== undefined) {
                    obsStats.streaming = message.d.responseData.outputActive;
                    console.log('Updated streaming status:', obsStats.streaming);
                }
                break;
            case 'GetRecordStatus':
                if (message.d.responseData && message.d.responseData.outputActive !== undefined) {
                    obsStats.recording = message.d.responseData.outputActive;
                    console.log('Updated recording status:', obsStats.recording);
                }
                break;
            default:
                console.log('Unhandled response type:', message.d.requestType);
        }
        updateStatus('obsWebSocket', 'connected');
    } else {
        console.log('Unexpected response format:', message);
    }
}

function authenticateObs(password) {
    const authRequest = {
        op: 1,
        d: {
            rpcVersion: 1
        }
    };
    obsSocket.send(JSON.stringify(authRequest));
}

function handleAuthChallenge(message, password) {
    const { salt, challenge } = message.d;
    const secret = CryptoJS.SHA256(password + salt);
    const authResponse = CryptoJS.SHA256(secret + challenge);

    const authMessage = {
        op: 1,
        d: {
            rpcVersion: 1,
            authentication: authResponse.toString(CryptoJS.enc.Base64)
        }
    };
    obsSocket.send(JSON.stringify(authMessage));
}

function updateStatus(type, status) {
    connectionStatus[type] = status;
    console.log(`Updating status: ${type} = ${status}`);
    
    latestStatus = {
        connectionStatus: connectionStatus,
        messageStats: messageStats,
        obsStats: obsStats
    };

    // Attempt to send update to popup (if open)
    chrome.runtime.sendMessage({ 
        action: 'statusUpdate',
        ...latestStatus
    }, () => {
        if (chrome.runtime.lastError) {
            console.log('Error sending status update (this is normal if popup is closed):', chrome.runtime.lastError.message);
        } else {
            console.log('Status update sent successfully');
        }
    });
}

function forwardToObs(message) {
    if (obsSocket && obsSocket.readyState === WebSocket.OPEN) {
        obsSocket.send(message);
        messageStats.forwarded++;
    } else {
        console.warn('OBS WebSocket not connected. Message not forwarded.');
    }
}

function getOBSStats() {
    if (obsSocket && obsSocket.readyState === WebSocket.OPEN) {
        // Get scene list
        sendOBSRequest('GetSceneList', {}, (response) => {
            handleOBSResponse(response);
        });

        // Get sources list
        sendOBSRequest('GetInputList', {}, (response) => {
            handleOBSResponse(response);
        });

        // Get streaming status
        sendOBSRequest('GetStreamStatus', {}, (response) => {
            handleOBSResponse(response);
        });

        // Get recording status
        sendOBSRequest('GetRecordStatus', {}, (response) => {
            handleOBSResponse(response);
        });
    }
}

function sendOBSRequest(requestType, requestData, callback) {
    if (!obsSocket || obsSocket.readyState !== WebSocket.OPEN) {
        console.error('OBS WebSocket is not connected');
        return;
    }

    const requestId = Math.random().toString(36).substr(2, 9);
    const request = {
        op: 6,
        d: {
            requestType: requestType,
            requestId: requestId,
            ...requestData
        }
    };

    console.log('Sending OBS request:', request);
    obsSocket.send(JSON.stringify(request));

    const messageHandler = (event) => {
        const message = JSON.parse(event.data);
        if (message.op === 7 && message.d.requestId === requestId) {
            obsSocket.removeEventListener('message', messageHandler);
            callback(message);
        }
    };

    obsSocket.addEventListener('message', messageHandler);
}

// Remove or comment out the periodic OBS stats update
// setInterval(getOBSStats, 5000);  // Update every 5 seconds

function disconnectFromObs() {
    if (obsSocket && obsSocket.readyState === WebSocket.OPEN) {
        obsSocket.close();
        console.log('Disconnected from OBS WebSocket');
        updateStatus('obsWebSocket', 'disconnected');
        // Reset OBS stats
        obsStats = {
            scenes: 0,
            sources: 0,
            streaming: false,
            recording: false
        };
    } else {
        console.log('OBS WebSocket is not connected');
    }
}