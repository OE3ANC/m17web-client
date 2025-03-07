# m17web client

This is the client for [m17web-proxy](https://github.com/OE3ANC/m17web-proxy). The source code for the compiled codec2 wasm module can be found here: [m17web-wasm](https://github.com/OE3ANC/m17web-wasm)

### Usage
Include the javascript module and create an instance of the player:

```javascript
    <m17-web-player 
      proxy="m17rx.oe3xor.at" 
      reflector="M17-XOR"
      module="C" 
      label="M17-XOR C"
      theme="light"
      >
    </m17-web-player>

  <script type="module" src="./lib/m17web-player.js"></script>
```

[Demo](https://stream.m17.app)
