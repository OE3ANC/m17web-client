import init, { decode } from './M17web/m17web_wasm.js';

/**
 * WebSocketManager - Singleton for managing shared WebSocket connections
 * Handles connection pooling, reference counting, and event dispatching
 */
const WebSocketManager = (() => {
  const connections = {};
  const statusConnections = {};
  const listeners = {};

  // Helper function to handle events for all listeners
  const notifyListeners = (key, eventName, event) => {
    if (listeners[key]) {
      listeners[key].forEach(listener => {
        if (listener[eventName]) listener[eventName](event);
      });
    }
  };

  // Create event handlers for a WebSocket
  const createEventHandlers = (ws, key, isStatus) => {
    ws.onopen = () => {
      console.log(`${isStatus ? 'Status connection' : 'Connection'} to ${key} established`);
      notifyListeners(key, 'onopen');
    };

    ws.onclose = () => {
      console.log(`${isStatus ? 'Status connection' : 'Connection'} to ${key} closed`);
      if (isStatus) {
        delete statusConnections[key];
      } else {
        delete connections[key];
      }
      notifyListeners(key, 'onclose');
    };

    ws.onerror = (evt) => {
      console.log(`${isStatus ? 'Status connection' : 'Connection'} error: ${evt.data}`);
      notifyListeners(key, 'onerror', evt);
    };

    ws.onmessage = (evt) => {
      notifyListeners(key, 'onmessage', evt);
    };
  };

  return {
    // Get or create a status connection
    getStatusConnection(proxy) {
      const key = `status:${proxy}`;

      if (!statusConnections[key]) {
        const ws = new WebSocket(`wss://${proxy}/`);
        createEventHandlers(ws, key, true);
        statusConnections[key] = ws;
      }

      return statusConnections[key];
    },

    // Get or create a data connection
    getConnection(proxy, reflector, module) {
      const key = `${proxy}/${reflector}/${module}`;

      if (!connections[key]) {
        const ws = new WebSocket(`wss://${proxy}/${reflector}/${module}`);
        ws.binaryType = "arraybuffer";
        createEventHandlers(ws, key, false);

        connections[key] = {
          ws,
          refCount: 0
        };
      }

      connections[key].refCount++;
      return connections[key].ws;
    },

    // Register a listener for a connection
    registerListener(proxy, reflector, module, listenerObj, isStatus = false) {
      const key = isStatus ? `status:${proxy}` : `${proxy}/${reflector}/${module}`;

      if (!listeners[key]) {
        listeners[key] = [];
      }

      listeners[key].push(listenerObj);
      return listeners[key].length - 1; // Return the index for later removal
    },

    // Unregister a listener
    unregisterListener(proxy, reflector, module, index, isStatus = false) {
      const key = isStatus ? `status:${proxy}` : `${proxy}/${reflector}/${module}`;

      if (listeners[key] && listeners[key][index]) {
        listeners[key][index] = {}; // Empty the listener but keep the index
      }

      // If this was a regular connection, decrement the reference count
      if (!isStatus && connections[key]) {
        connections[key].refCount--;

        // If no more references, close the connection
        if (connections[key].refCount <= 0) {
          connections[key].ws.close();
          delete connections[key];
        }
      }
    }
  };
})();

/**
 * M17webPlayer - Custom HTML element for M17 audio streaming
 * Uses shared WebSocket connections for efficiency
 */
export class M17webPlayer extends HTMLElement {
  constructor() {
    super();
    this._wsListenerIndex = -1;
    this._statusListenerIndex = -1;
  }

  static observedAttributes = ["proxy", "reflector", "module", "label", "theme"];

  // Properties
  proxy = '';
  reflector = '';
  module = '';
  label = '';
  theme = 'dark'; // default theme

  // Private properties
  _ws = null;
  _statusWs = null;
  _audioCtx = null;
  _receive_buffer = new Uint8Array(0);
  _gain = 3;
  _src_call = '';
  _playerSymbol = '▶';
  _playerActive = false;
  _wsListenerIndex = -1;
  _statusListenerIndex = -1;

  // Lifecycle methods
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    switch(name) {
      case "proxy":
        this.proxy = newValue;
        this._reconnectIfNeeded();
        break;
      case "reflector":
        this.reflector = newValue;
        this._reconnectIfNeeded();
        break;
      case "module":
        this.module = newValue;
        this._reconnectIfNeeded();
        break;
      case "label":
        this.label = newValue;
        break;
      case "theme":
        this.theme = newValue;
        this.resetTheme();
        break;
    }
  }

  connectedCallback() {
    // Initialize WASM
    init();

    // Create the UI
    this._createUI();

    // Connect to status server
    this._connectToServerStatus();
  }

  disconnectedCallback() {
    this._disconnectWebSockets();
  }

  // Theme methods
  resetTheme() {
    if (this.shadowRoot) {
      const card = this.shadowRoot.getElementById('playerCard');
      if (card) {
        card.className = `player-card ${this.theme}-theme`;
      }
    }
  }

  txTheme() {
    if (this.shadowRoot) {
      const card = this.shadowRoot.getElementById('playerCard');
      if (card) {
        card.className = `player-card red-theme`;
      }
    }
  }

  // Connection management
  _reconnectIfNeeded() {
    if (this._playerActive && this.proxy && this.reflector && this.module) {
      this._disconnectWebSockets();
      this._connectToServer();
    } else if (!this._playerActive) {
      this._connectToServerStatus();
    }
  }

  _disconnectWebSockets() {
    // Unregister listeners but don't close the shared connections
    if (this._wsListenerIndex >= 0) {
      WebSocketManager.unregisterListener(this.proxy, this.reflector, this.module, this._wsListenerIndex);
      this._wsListenerIndex = -1;
    }

    if (this._statusListenerIndex >= 0) {
      WebSocketManager.unregisterListener(this.proxy, '', '', this._statusListenerIndex, true);
      this._statusListenerIndex = -1;
    }

    this._ws = null;
    this._statusWs = null;
  }

  _connectToServerStatus() {
    if (!this.proxy) return;

    const shadow = this.shadowRoot;
    const self = this;

    // Unregister previous listener if exists
    if (this._statusListenerIndex >= 0) {
      WebSocketManager.unregisterListener(this.proxy, '', '', this._statusListenerIndex, true);
    }

    // Create listener object
    const statusListener = {
      onmessage: function(evt) {
        let received_msg = JSON.parse(evt.data);

        if (Array.isArray(received_msg)) {
          received_msg.forEach((entry) => {
            if (entry.reflector == self.reflector && entry.module == self.module) {
              shadow.getElementById("playerLastCall").textContent = `Last Heard: ${entry.last_qso_call}`;

              if (entry.active_qso) {
                shadow.getElementById("playerCallsign").textContent = entry.last_qso_call;
                self.txTheme();
                // Visual feedback - pulse animation
                const callsignEl = shadow.getElementById("playerCallsign");
                callsignEl.classList.add("pulse");
                setTimeout(() => callsignEl.classList.remove("pulse"), 300);
              } else {
                shadow.getElementById("playerCallsign").textContent = self.label;
                self.resetTheme();
              }
            }
          });
        }
      }
    };

    // Register the listener and get the shared connection
    this._statusListenerIndex = WebSocketManager.registerListener(
      this.proxy, '', '', statusListener, true
    );
    this._statusWs = WebSocketManager.getStatusConnection(this.proxy);
  }

  _connectToServer() {
    if (!this.proxy || !this.reflector || !this.module) {
      console.error("Cannot connect: missing proxy, reflector, or module");
      return;
    }

    const shadow = this.shadowRoot;
    const self = this;

    // Unregister previous listener if exists
    if (this._wsListenerIndex >= 0) {
      WebSocketManager.unregisterListener(this.proxy, this.reflector, this.module, this._wsListenerIndex);
    }

    // Create listener object
    const wsListener = {
      onopen: function() {
        shadow.getElementById("connectionStatus").textContent = "Streaming";
        shadow.getElementById("connectionStatus").className = "status-connected";
      },
      onclose: function() {
        shadow.getElementById("connectionStatus").textContent = "";
        shadow.getElementById("connectionStatus").className = "status-disconnected";
        self._playerActive = false;
        self._playerSymbol = "▶";
        shadow.getElementById("playerButton").textContent = self._playerSymbol;
      },
      onerror: function(evt) {
        shadow.getElementById("connectionStatus").textContent = "Error";
        shadow.getElementById("connectionStatus").className = "status-error";
      },
      onmessage: function(evt) {
        let received_msg = JSON.parse(evt.data);
        self._receive_buffer = new Uint8Array([...self._receive_buffer, ...new Uint8Array(self._arrayToArrayBuffer(received_msg.c2_stream))]);
        if (self._receive_buffer.length >= 128 || received_msg.done) {
          self._playResult(decode(self._receive_buffer));
          self._receive_buffer = new Uint8Array(0);
        }
      }
    };

    // Register the listener and get the shared connection
    this._wsListenerIndex = WebSocketManager.registerListener(
      this.proxy, this.reflector, this.module, wsListener
    );
    this._ws = WebSocketManager.getConnection(this.proxy, this.reflector, this.module);
  }

  // Utility methods
  _arrayToArrayBuffer(array) {
    let arrayBuffer = new ArrayBuffer(array.length);
    let bufferView = new Uint8Array(arrayBuffer);
    for (let i = 0; i < array.length; i++) {
      bufferView[i] = array[i];
    }
    return arrayBuffer;
  }

  _togglePlay() {
    if (this._playerActive) {
      // Just unregister our listener, don't close the shared connection
      if (this._wsListenerIndex >= 0) {
        WebSocketManager.unregisterListener(this.proxy, this.reflector, this.module, this._wsListenerIndex);
        this._wsListenerIndex = -1;
        this._ws = null;
      }

      this._playerActive = false;
      this._playerSymbol = "▶";

      // Update UI
      this.shadowRoot.getElementById("connectionStatus").textContent = "";
      this.shadowRoot.getElementById("connectionStatus").className = "status-disconnected";
    } else {
      this._playerActive = true;
      if (!this._audioCtx) {
        this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      this._connectToServer();
      this._playerSymbol = "⏸";
    }
    this.shadowRoot.getElementById("playerButton").textContent = this._playerSymbol;
  }

  _playResult(result) {
    let source = this._audioCtx.createBufferSource();
    let buffer = this._audioCtx.createBuffer(1, result.length, 8000);
    let data = buffer.getChannelData(0);
    for (let i = 0; i < result.length; i++) {
      data[i] = (result[i] / 32768.0) * this._gain;
    }
    source.buffer = buffer;
    source.connect(this._audioCtx.destination);
    source.start();
  }

  // UI creation
  _createUI() {
    // Custom Element setup
    const shadow = this.attachShadow({ mode: "open" });

    // Create card container
    const card = document.createElement("div");
    card.setAttribute("id", "playerCard");
    card.className = `player-card ${this.theme}-theme`;

    // Create header
    const header = document.createElement("div");
    header.className = "card-header";

    const player_logo = document.createElement("img");
    player_logo.src = "img/m17glow.png";
    player_logo.setAttribute("id", "playerLogo");
    player_logo.title = "M17web Player by OE3ANC";

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = "M17 Player";

    header.appendChild(player_logo);
    header.appendChild(title);

    // Create body
    const body = document.createElement("div");
    body.className = "card-body";

    const callsignContainer = document.createElement("div");
    callsignContainer.className = "callsign-container";

    const callsignLabel = document.createElement("span");
    callsignLabel.className = "label";
    callsignLabel.textContent = "Callsign:";

    const player_callsign = document.createElement("span");
    player_callsign.textContent = this._src_call || this.label;
    player_callsign.setAttribute("id", "playerCallsign");
    player_callsign.className = "callsign";

    callsignContainer.appendChild(callsignLabel);
    callsignContainer.appendChild(player_callsign);

    const statusContainer = document.createElement("div");
    statusContainer.className = "status-container";

    const connectionStatus = document.createElement("span");
    connectionStatus.setAttribute("id", "connectionStatus");
    connectionStatus.className = "status-disconnected";
    connectionStatus.textContent = "";

    const playerLastCall = document.createElement("span");
    playerLastCall.setAttribute("id", "playerLastCall");
    playerLastCall.className = "player-status";
    playerLastCall.textContent = "LastCall";

    statusContainer.appendChild(connectionStatus);
    statusContainer.appendChild(playerLastCall);

    body.appendChild(callsignContainer);
    body.appendChild(statusContainer);

    // Create footer
    const footer = document.createElement("div");
    footer.className = "card-footer";

    const player_button = document.createElement("button");
    player_button.textContent = "▶";
    player_button.setAttribute("id", "playerButton");
    player_button.className = "play-button";
    player_button.onclick = () => this._togglePlay();

    const volumeContainer = document.createElement("div");
    volumeContainer.className = "volume-container";

    const volumeIcon = document.createElement("span");
    volumeIcon.className = "volume-icon";
    volumeIcon.textContent = "🔊";

    const player_slider = document.createElement("input");
    player_slider.setAttribute("id", "playerSlider");
    player_slider.className = "volume-slider";
    player_slider.type = "range";
    player_slider.min = 0;
    player_slider.max = 4.0;
    player_slider.step = 0.1;
    player_slider.value = 3.0;
    player_slider.addEventListener('input', (e) => {
      this._gain = e.target.value;
    });

    volumeContainer.appendChild(volumeIcon);
    volumeContainer.appendChild(player_slider);

    footer.appendChild(player_button);
    footer.appendChild(volumeContainer);

    // Assemble card
    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(footer);

    // Create CSS
    const style = document.createElement("style");
    style.textContent = `
      .player-card {
        width: 300px;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        margin: 15px;
        transition: all 0.3s ease;
        font-family: 'Roboto', sans-serif;
      }

      .player-card:hover {
        transform: translateY(-5px);
        box-shadow: 0 8px 25px rgba(0,0,0,0.2);
      }

      .dark-theme {
        background: #2a2a2a;
        color: #ffffff;
        transition: all 1s ease;
      }

      .light-theme {
        background: #ffffff;
        color: #333333;
      }

      .blue-theme {
        background: linear-gradient(135deg, #1e3c72, #2a5298);
        color: #ffffff;
      }

      .green-theme {
        background: linear-gradient(135deg, #134e5e, #71b280);
        color: #ffffff;
      }

      .red-theme {
        background: rgb(56, 56, 56);
        color: #ffffff;
      }

      .card-header {
        padding: 15px;
        display: flex;
        align-items: center;
        border-bottom: 1px solid rgba(255,255,255,0.1);
      }

      .dark-theme .card-header, .red-theme .card-header {
        background: #222222;
      }

      .light-theme .card-header {
        background: #f5f5f5;
      }

      #playerLogo {
        max-width: 35px;
        max-height: 35px;
        width: auto;
        height: auto;
        margin-right: 10px;
        border-radius: 50%;
      }

      .card-title {
        font-size: 18px;
        font-weight: 500;
      }

      .card-body {
        padding: 20px 15px;
      }

      .callsign-container {
        margin-bottom: 15px;
        display: flex;
        justify-content: space-between;
      }

      .label {
        font-size: 14px;
        opacity: 0.8;
      }

      .callsign {
        font-weight: 600;
        font-size: 16px;
      }

      .status-container {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
      }

      .status-connected {
        color: #4CAF50;
      }

      .status-disconnected {
        color: #9E9E9E;
      }

      .status-error {
        color: #F44336;
      }

      .card-footer {
        padding: 15px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-top: 1px solid rgba(255,255,255,0.1);
      }

      .dark-theme .card-footer, .red-theme .card-footer {
        background: #222222;
      }

      .light-theme .card-footer {
        background: #f5f5f5;
      }

      .play-button {
        width: 50px;
        height: 50px;
        border-radius: 50%;
        border: none;
        background: #4285F4;
        color: white;
        font-size: 20px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
      }

      .play-button:hover {
        background: #3367D6;
        transform: scale(1.05);
      }

      .volume-container {
        display: flex;
        align-items: center;
        width: 60%;
      }

      .volume-icon {
        margin-right: 10px;
      }

      .volume-slider {
        -webkit-appearance: none;
        width: 100%;
        height: 4px;
        border-radius: 2px;
        background: rgba(255,255,255,0.3);
        outline: none;
      }

      .light-theme .volume-slider {
        background: rgba(0,0,0,0.2);
      }

      .volume-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 15px;
        height: 15px;
        border-radius: 50%;
        background: #4285F4;
        cursor: pointer;
        transition: all 0.2s ease;
      }

      .volume-slider::-webkit-slider-thumb:hover {
        transform: scale(1.2);
      }

      .pulse {
        animation: pulse-animation 0.3s ease-in-out;
      }

      @keyframes pulse-animation {
        0% { transform: scale(1); }
        50% { transform: scale(1.1); }
        100% { transform: scale(1); }
      }
    `;

    // Attach elements to shadow DOM
    shadow.appendChild(style);
    shadow.appendChild(card);
  }
}

customElements.define("m17-web-player", M17webPlayer);
