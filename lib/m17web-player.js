import init, { decode } from './M17web/m17web_wasm.js';

class M17webPlayer extends HTMLElement {
  constructor() {
    super();
  }

  static observedAttributes = ["proxy", "label", "theme"];

  attributeChangedCallback(name, oldValue, newValue) {
    switch(name) {
      case "proxy":
        this.proxy = newValue;
        break;
      case "label":
        this.label = newValue;
        break;
      case "theme":
        this.theme = newValue;
        this.updateTheme();
        break;
    }
  }

  proxy = '';
  label = '';
  theme = 'dark'; // default theme

  updateTheme() {
    if (this.shadowRoot) {
      const card = this.shadowRoot.getElementById('playerCard');
      if (card) {
        card.className = `player-card ${this.theme}-theme`;
      }
    }
  }

  connectedCallback() {
    // M17 Web Player functionality
    let ws;
    let audioCtx;
    let receive_buffer = new Uint8Array(0);
    let label = this.label;
    let proxy = this.proxy;
    let gain = 3;
    let src_call = this.label;
    let playerSymbol = '▶';
    let playerActive = false;

    init();

    function connectToServer() {
      ws = new WebSocket(proxy);
      ws.binaryType = "arraybuffer";
      ws.onopen = function () {
        console.log("Connected to server");
        shadow.getElementById("connectionStatus").textContent = "Connected";
        shadow.getElementById("connectionStatus").className = "status-connected";
      };
      ws.onclose = function () {
        console.log("Disconnected from server");
        shadow.getElementById("connectionStatus").textContent = "Disconnected";
        shadow.getElementById("connectionStatus").className = "status-disconnected";
      };
      ws.onerror = function (evt) {
        console.log("Error: " + evt.data);
        shadow.getElementById("connectionStatus").textContent = "Error";
        shadow.getElementById("connectionStatus").className = "status-error";
      };
      ws.onmessage = function (evt) {
        let received_msg = JSON.parse(evt.data);
        src_call = received_msg.done == true ? label : received_msg.src_call;
        receive_buffer = new Uint8Array([...receive_buffer, ...new Uint8Array(arrayToArrayBuffer(received_msg.c2_stream))]);
        if (receive_buffer.length >= 128 || received_msg.done) {
          playResult(decode(receive_buffer));
          receive_buffer = new Uint8Array(0);
        }
        shadow.getElementById("playerCallsign").textContent = src_call;
      };
    }

    function arrayToArrayBuffer(array) {
      let arrayBuffer = new ArrayBuffer(array.length);
      let bufferView = new Uint8Array(arrayBuffer);
      for (let i = 0; i < array.length; i++) {
        bufferView[i] = array[i];
      }
      return arrayBuffer;
    }

    function togglePlay() {
      if (playerActive) {
        ws.close();
        playerActive = false;
        playerSymbol = "▶";
        shadow.getElementById("playerStatus").textContent = "Ready";
      } else {
        playerActive = true;
        if (!audioCtx) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        connectToServer();
        playerSymbol = "⏸";
        shadow.getElementById("playerStatus").textContent = "Playing";
      }
      shadow.getElementById("playerButton").textContent = playerSymbol;
    }

    function playResult(result) {
      let source = audioCtx.createBufferSource();
      let buffer = audioCtx.createBuffer(1, result.length, 8000);
      let data = buffer.getChannelData(0);
      for (let i = 0; i < result.length; i++) {
        data[i] = (result[i] / 32768.0) * gain;
      }
      source.buffer = buffer;
      source.connect(audioCtx.destination);
      source.start();

      // Visual feedback - pulse animation
      const callsignEl = shadow.getElementById("playerCallsign");
      callsignEl.classList.add("pulse");
      setTimeout(() => callsignEl.classList.remove("pulse"), 300);
    }

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
    player_callsign.textContent = src_call;
    player_callsign.setAttribute("id", "playerCallsign");
    player_callsign.className = "callsign";

    callsignContainer.appendChild(callsignLabel);
    callsignContainer.appendChild(player_callsign);

    const statusContainer = document.createElement("div");
    statusContainer.className = "status-container";

    const connectionStatus = document.createElement("span");
    connectionStatus.setAttribute("id", "connectionStatus");
    connectionStatus.className = "status-disconnected";
    connectionStatus.textContent = "Disconnected";

    const playerStatus = document.createElement("span");
    playerStatus.setAttribute("id", "playerStatus");
    playerStatus.className = "player-status";
    playerStatus.textContent = "Ready";

    statusContainer.appendChild(connectionStatus);
    statusContainer.appendChild(playerStatus);

    body.appendChild(callsignContainer);
    body.appendChild(statusContainer);

    // Create footer
    const footer = document.createElement("div");
    footer.className = "card-footer";

    const player_button = document.createElement("button");
    player_button.textContent = "▶";
    player_button.setAttribute("id", "playerButton");
    player_button.className = "play-button";
    player_button.onclick = togglePlay;

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
    player_slider.addEventListener('input', function() {
      gain = this.value;
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

      .card-header {
        padding: 15px;
        display: flex;
        align-items: center;
        border-bottom: 1px solid rgba(255,255,255,0.1);
      }

      .dark-theme .card-header {
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

      .dark-theme .card-footer {
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
