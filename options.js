document.addEventListener('DOMContentLoaded', function() {
    chrome.storage.sync.get(['forwardUrl', 'wsPassword'], function(result) {
        document.getElementById('forward-url').value = result.forwardUrl || 'ws://localhost:4444';
        document.getElementById('ws-password').value = result.wsPassword || '';
    });
    
    document.getElementById('save-settings').addEventListener('click', function() {
        const forwardUrl = document.getElementById('forward-url').value;
        const wsPassword = document.getElementById('ws-password').value;
        chrome.storage.sync.set({ forwardUrl, wsPassword }, function() {
            alert('Settings saved!');
        });
    });
});
