import * as dgram from "node:dgram";
import * as fs from "node:fs";
import path from "path";
import { Data } from "./data";

const server = dgram.createSocket("udp4");
const CHUNK_SIZE = 600;
const TIMEOUT = 1000; // 1 segundo para timeout
const MAX_RETRIES = 3;

// Mapa para almacenar los chunks enviados y sus estados
const sentChunks = new Map<string, {
    chunk: Buffer,
    attempts: number,
    acked: boolean,
    timestamp: number
}>();

// Función para generar ID único para cada chunk
const getChunkId = (clientId: string, fileName: string, partNumber: number) => {
    return `${clientId}-${fileName}-${partNumber}`;
};

server.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const clientId = `${rinfo.address}:${rinfo.port}`;

    try {
        const request = JSON.parse(msg.toString());

        if (request.contentType === "ack") {
            console.log(`Servidor recibió ACK de ${clientId}`);
            const chunkId = getChunkId(clientId, request.fileName, request.part);
            if (sentChunks.has(chunkId)) {
                const chunkInfo = sentChunks.get(chunkId)!;
                chunkInfo.acked = true;
                console.log(`Servidor recibió ACK de ${clientId} para el chunk ${request.part}`);
            } else {
                console.log(`Servidor recibió ACK de ${clientId} para el chunk ${request.part} pero no se encontró en el buffer`);
            }
            return;
        }

        const filePaths = path.join(__dirname, "files");

        if (request.contentType === "filePaths") {
            const files = fs.readdirSync(filePaths);
            const response = new Data("filePaths", 0, files.length, JSON.stringify(files));
            server.send(JSON.stringify(response), rinfo.port, rinfo.address);
            return;
        }

        const filePath = path.join(__dirname, "files", request.content);

        if (!fs.existsSync(filePath)) {
            const error = JSON.stringify({ error: "File not found" });
            const dataMessage = new Data("filePaths", 0, error.length, error);
            server.send(JSON.stringify(dataMessage), rinfo.port, rinfo.address);
            return;
        }

        const fileBuffer = fs.readFileSync(filePath);
        const totalChunks = Math.ceil(fileBuffer.length / CHUNK_SIZE);

        const fileName = request.content;
        const responseFileName = new Data("fileName", 0, totalChunks, fileName);
        server.send(JSON.stringify(responseFileName), rinfo.port, rinfo.address);

        setTimeout(() => {
            let index = 0;
                const start = index * CHUNK_SIZE;
                const end = Math.min((index + 1) * CHUNK_SIZE, fileBuffer.length);
                const chunk = fileBuffer.subarray(start, end);
                const chunkId = getChunkId(clientId, fileName, index);
                sentChunks.set(chunkId, {
                    chunk,
                    attempts: 0,
                    acked: false,
                    timestamp: Date.now()
                });
                sendChunk(chunk, index, fileName, rinfo, chunkId);
                index++;
                if(index === totalChunks) {
                    startChunkVerification(clientId, fileName, totalChunks, rinfo);
                };
        }, 100);

    } catch (error) {
        console.error("Error procesando mensaje:", error);
    }
});

const sendChunk = (
    chunk: Buffer,
    partNumber: number,
    fileName: string,
    rinfo: dgram.RemoteInfo,
    chunkId: string
) => {
    const response = new Data("filePart", partNumber, chunk.length, chunk.toString("base64"));
    const jsonResponse = JSON.stringify(response);

    server.send(jsonResponse, rinfo.port, rinfo.address, (error) => {
        if (error) {
            console.error(`Error enviando chunk ${partNumber}:`, error);
        } else {
            console.log(`Chunk ${partNumber} enviado`);
            const chunkInfo = sentChunks.get(chunkId);
            if (chunkInfo) {
                chunkInfo.timestamp = Date.now();
                chunkInfo.attempts++;
            }
        }
    });
};

const startChunkVerification = (
    clientId: string,
    fileName: string,
    totalChunks: number,
    rinfo: dgram.RemoteInfo
) => {
    console.log("Iniciando verificación de chunks");
    const verificationInterval = setInterval(() => {
        let allAcked = true;
        let remainingChunks = false;

        for (let i = 0; i < totalChunks; i++) {
            const chunkId = getChunkId(clientId, fileName, i);
            const chunkInfo = sentChunks.get(chunkId);

            if (chunkInfo && !chunkInfo.acked) {
                allAcked = false;

                if (
                    Date.now() - chunkInfo.timestamp > TIMEOUT &&
                    chunkInfo.attempts < MAX_RETRIES
                ) {
                    console.log(`Reenviando chunk ${i} (intento ${chunkInfo.attempts + 1})`);
                    sendChunk(chunkInfo.chunk, i, fileName, rinfo, chunkId);
                    remainingChunks = true;
                } else if (chunkInfo.attempts >= MAX_RETRIES) {
                    console.log(`Chunk ${i} alcanzó el máximo de intentos`);
                }
            }
        }

        if (allAcked || !remainingChunks) {
            console.log("Verificación de chunks completada");
            server.send("", rinfo.port, rinfo.address);
            clearInterval(verificationInterval);

            // Agregar un pequeño retraso antes de eliminar los chunks del buffer
            if (Object.values(sentChunks).every(chunk => chunk.acked)) {
                console.log("Todos los chunks recibieron ACK. Eliminando del buffer.");
                sentChunks.clear();
            }
        }
    }, TIMEOUT);
};

server.on("error", (err) => {
    console.log("Error en la conexión:", err);
});

server.on("listening", () => {
    console.log(`Servidor escuchando en: ${server.address().address}:${server.address().port}`);
});

server.bind(3000);