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

let debuggeeId = null;

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
        case "toggleChromeWs":
            if (debuggeeId) {
                chrome.debugger.detach(debuggeeId);
                debuggeeId = null;
                updateStatus('chromeWebSocket', 'disconnected');
            } else {
                attachDebugger(request.tabId);
            }
            sendResponse({success: true});
            break;
    }
    return true;  // Indicates that the response is sent asynchronously
});

chrome.action.onClicked.addListener((tab) => {
    if (debuggeeId) {
        chrome.debugger.detach(debuggeeId);
        debuggeeId = null;
        updateStatus('chromeWebSocket', 'disconnected');
    } else {
        attachDebugger(tab.id);
    }
});

function attachDebugger(tabId) {
    chrome.debugger.attach({tabId: tabId}, "1.3", () => {
        if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError.message);
            return;
        }
        debuggeeId = {tabId: tabId};
        chrome.debugger.sendCommand(debuggeeId, "Network.enable");
        chrome.debugger.onEvent.addListener(onEvent);
        updateStatus('chromeWebSocket', 'connected');
    });
}

function onEvent(debuggeeId, message, params) {
    if (message === "Network.webSocketFrameReceived") {
        const payload = params.response?.payloadData || params.request?.payloadData;
        if (payload) {
            console.log("WebSocket Frame Received:", payload);
            messageStats.received++;
            try {
                // Attempt to parse the message to ensure it's valid JSON
                JSON.parse(payload);
                forwardToObs(payload);
            } catch (error) {
                console.error("Error parsing WebSocket frame:", error);
                messageStats.lost++;
            }
        } else {
            console.warn("Received WebSocket frame without payload data");
        }
    } else if (message === "Network.webSocketFrameSent") {
        const payload = params.request?.payloadData;
        if (payload) {
            console.log("WebSocket Frame Sent:", payload);
            messageStats.sent++;
        } else {
            console.warn("Sent WebSocket frame without payload data");
        }
    }
    updateStatus('chromeWebSocket', 'connected');
}

function connectToObs() {
    chrome.storage.sync.get(['forwardUrl', 'wsPassword'], function(result) {
        const forwardUrl = result.forwardUrl || 'ws://localhost:4455';
        const wsPassword = result.wsPassword || '';

        console.log('Attempting to connect to OBS WebSocket at:', forwardUrl);

        if (obsSocket && obsSocket.readyState === WebSocket.OPEN) {
            console.log('Already connected to OBS WebSocket');
            return;
        }

        obsSocket = new WebSocket(forwardUrl);

        // obs-websocket v5 handshake: wait for Hello (op 0), answer with
        // Identify (op 1) — including the auth response if OBS challenges.
        obsSocket.onopen = () => {
            console.log('OBS WebSocket connection opened, waiting for Hello');
        };

        obsSocket.onerror = (error) => {
            console.error('OBS WebSocket Error:', error);
            updateStatus('obsWebSocket', 'error');
        };

        obsSocket.onclose = (event) => {
            // 4008/4009 = authentication missing/failed per the v5 spec
            const authCodes = { 4008: 'auth required', 4009: 'auth failed' };
            const reason = authCodes[event.code] || event.reason || '';
            console.log('Disconnected from OBS WebSocket. Code:', event.code, 'Reason:', reason);
            updateStatus('obsWebSocket', authCodes[event.code] ? 'auth_failed' : 'disconnected');
        };

        obsSocket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            handleOBSMessage(message, wsPassword);
        };
    });
}

async function sha256B64(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function handleOBSMessage(message, password) {
    switch (message.op) {
        case 0: { // Hello -> Identify (with auth answer if challenged)
            const identify = { op: 1, d: { rpcVersion: 1, eventSubscriptions: 0 } };
            const auth = message.d.authentication;
            if (auth) {
                if (!password) {
                    console.error('OBS requires a password — set it in the extension options.');
                    updateStatus('obsWebSocket', 'auth_failed');
                    obsSocket.close();
                    return;
                }
                const secret = await sha256B64(password + auth.salt);
                identify.d.authentication = await sha256B64(secret + auth.challenge);
            }
            obsSocket.send(JSON.stringify(identify));
            break;
        }
        case 2: // Identified
            console.log('Identified successfully with OBS');
            updateStatus('obsWebSocket', 'authenticated');
            getOBSStats();
            break;
        case 7: // Request response
            handleOBSResponse(message);
            break;
        default:
            console.log('Unhandled message type:', message.op);
    }
}

function handleOBSResponse(message) {
    console.log('Received response from OBS:', message);
    if (message.d && message.d.requestType) {
        // count rejected requests as lost instead of pretending they forwarded
        if (message.d.requestStatus && !message.d.requestStatus.result) {
            console.error('OBS rejected', message.d.requestType, message.d.requestStatus);
            if (message.d.requestType === 'BroadcastCustomEvent') {
                messageStats.lost++;
                if (messageStats.forwarded > 0) messageStats.forwarded--;
            }
            return;
        }
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
            case 'BroadcastCustomEvent':
                console.log('Custom event broadcasted successfully');
                break;
            default:
                console.log('Unhandled response type:', message.d.requestType);
        }
        updateStatus('obsWebSocket', 'connected');
    } else {
        console.log('Unexpected response format:', message);
    }
}

function updateStatus(type, status) {
     // Only update if the status has changed
    if (connectionStatus[type] !== status) {
        connectionStatus[type] = status;
        console.log(`Updating status: ${type} = ${status}`);
        
        latestStatus = {
            connectionStatus: connectionStatus,
            messageStats: messageStats,
            obsStats: obsStats
        };

        // Use chrome.runtime.sendMessage instead of chrome.tabs.sendMessage
        chrome.runtime.sendMessage({ 
            action: 'statusUpdate',
            ...latestStatus
        }).catch(error => {
            console.log('Error sending status update:', error.message);
        });
        
        // Update extension icon
        const iconPath = status === 'connected' ? {
            16: 'images/icon_active_16.png',
            32: 'images/icon_active_32.png',
            48: 'images/icon_active_48.png',
            128: 'images/icon_active_128.png'
        } : {
            16: 'images/icon_inactive_16.png',
            32: 'images/icon_inactive_32.png',
            48: 'images/icon_inactive_48.png',
            128: 'images/icon_inactive_128.png'
        };
        chrome.action.setIcon({path: iconPath});
    }
}

function forwardToObs(message) {
    if (obsSocket && obsSocket.readyState === WebSocket.OPEN) {
        try {
            // Parse the Phoenix framework message
            const parsedMessage = JSON.parse(message);
            if (!Array.isArray(parsedMessage)) {
                throw new Error("Unexpected message format");
            }
            
            // Transform into an obs-websocket v5 BroadcastCustomEvent (the v4
            // name "BroadcastCustomMessage" is rejected by OBS 28+)
            const obsMessage = {
                op: 6,
                d: {
                    requestType: "BroadcastCustomEvent",
                    requestId: generateUniqueId(),
                    requestData: {
                        eventData: {
                            eventType: "ChromeWebSocketMessage",
                            eventData: {
                                channel: parsedMessage[2],
                                event: parsedMessage[3],
                                payload: parsedMessage[4]
                            }
                        }
                    }
                }
            };
            
            // Send the transformed message to OBS
            obsSocket.send(JSON.stringify(obsMessage));
            messageStats.forwarded++;
            console.log("Forwarded to OBS:", obsMessage);
        } catch (error) {
            console.error("Error forwarding message to OBS:", error);
            messageStats.lost++;
        }
    } else {
        console.warn('OBS WebSocket not connected. Message not forwarded.');
        messageStats.lost++;
    }
    updateStatus('obsWebSocket', obsSocket && obsSocket.readyState === WebSocket.OPEN ? 'connected' : 'disconnected');
}

function generateUniqueId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
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