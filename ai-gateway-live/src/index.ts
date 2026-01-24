import http from "http";
import { WebSocketServer } from "ws";
import { PORT } from "./config.js";
import { handleWebSocketConnection } from "./wsHandler.js";

const server = http.createServer();
const wss = new WebSocketServer({ server, path: "/acp" });

wss.on("connection", handleWebSocketConnection);

server.listen(PORT, () => {
  console.log(`[ai-gateway-live] listening on ws://localhost:${PORT}/acp`);
});
