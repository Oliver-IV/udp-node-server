import * as dgram from "node:dgram";
import * as fs from "node:fs";
import path from "path";
import { Data } from "./data";

const server = dgram.createSocket("udp4");
const CHUNK_SIZE = 1400;
const TIMEOUT = 1000; // 1 segundo para timeout
const MAX_RETRIES = 3;

// Mapa para almacenar los chunks enviados y sus estados
const sentChunks = new Map<string, {
    chunk: Buffer,
    timestamp: number,
    part: number
}>();

const ackedChunks = new Map<string, number>();

// Función para generar ID único para cada chunk
const getChunkId = (clientId: string, partNumber: number) => {
    return `${clientId}-${partNumber}`;
};

server.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const clientId = `${rinfo.address}:${rinfo.port}`;

    try {
        const request = JSON.parse(msg.toString());

        if (request.contentType === "ack") {
            processAck(clientId, request);
            return;
        }

        if (request.contentType === "filePaths") {
            processSendFilesNames(rinfo);
            return;
        }

        const filePath = path.join(__dirname, "files", request.content);

        if (!fs.existsSync(filePath)) {
            processNotFoundFile(rinfo, "File not found");
            return;
        }

        sendChunks(filePath, rinfo, clientId, request);

    } catch (error) {
        console.error("Error procesando mensaje:", error);
    }
});

function processAck(clientId: string, request: any) {
    console.log(`Servidor recibió ACK de ${clientId}`);
    const chunkId = getChunkId(clientId, request.part);
    if (sentChunks.has(chunkId)) {
        ackedChunks.set(chunkId, request.part);
        console.log(`Servidor recibió ACK de ${clientId} para el chunk ${request.part}`);
    } else {
        console.log(`Servidor recibió ACK de ${clientId} para el chunk ${request.part} pero no se encontró en el buffer`);
    }
    return;
}

function processSendFilesNames(rinfo: dgram.RemoteInfo) {
    const filePaths = path.join(__dirname, "files");
    const files = fs.readdirSync(filePaths);
    const response = new Data("filePaths", 0, files.length, JSON.stringify(files));
    server.send(JSON.stringify(response), rinfo.port, rinfo.address);
}

function processNotFoundFile(rinfo: dgram.RemoteInfo, error: string) {
    const errorResponse = new Data("filePaths", 0, error.length, error);
    server.send(JSON.stringify(errorResponse), rinfo.port, rinfo.address);
}

function sendChunks(filePath: string, rinfo: dgram.RemoteInfo, clientId: string, request: any) {
    const fileBuffer = fs.readFileSync(filePath);
    const totalChunks = Math.ceil(fileBuffer.length / CHUNK_SIZE);

    const fileName = request.content;
    const responseFileName = new Data("fileName", 0, totalChunks, fileName);
    server.send(JSON.stringify(responseFileName), rinfo.port, rinfo.address);

    console.log(`Enviando archivo: ${fileName} con ${totalChunks} chunks`);
    
    // Limpieza previa de cualquier chunk antiguo para este cliente
    clearClientChunks(clientId);
    
    // Usar Promise para manejar la finalización del envío de chunks
    const sendAllChunks = async () => {
        for (let index = 0; index < totalChunks; index++) {
            const start = index * CHUNK_SIZE;
            const end = Math.min((index + 1) * CHUNK_SIZE, fileBuffer.length);
            const chunk = fileBuffer.subarray(start, end);
            const chunkId = getChunkId(clientId, index);
            
            sentChunks.set(chunkId, {
                chunk,
                timestamp: Date.now(),
                part: index
            });
            
            // Aquí corregimos y usamos una promesa que envuelve la función sendChunk
            await new Promise<void>((resolve) => {
                const response = new Data("filePart", index, chunk.length, chunk.toString("base64"));
                const jsonResponse = JSON.stringify(response);

                server.send(jsonResponse, rinfo.port, rinfo.address, (error) => {
                    if (error) {
                        console.error(`Error enviando chunk ${index}:`, error);
                    } else {
                        console.log(`Chunk ${index} enviado`);
                        const chunkInfo = sentChunks.get(chunkId);
                        if (chunkInfo) {
                            chunkInfo.timestamp = Date.now();
                        }
                    }
                    resolve(); // Resolver la promesa después de enviar
                });
            });
            
            // Pequeña pausa entre envíos para no saturar el buffer
            await new Promise(resolve => setImmediate(resolve));
        }
        
        console.log("Todos los chunks enviados. Iniciando verificación...");
        // Esperar un poco antes de iniciar la verificación para dar tiempo a recibir ACKs
        setTimeout(() => {
            startChunkVerification(clientId, totalChunks, rinfo);
        }, 500);
    };
    
    // Iniciar el proceso de envío
    sendAllChunks().catch(err => {
        console.error("Error enviando chunks:", err);
    });
}

function sendChunk(
    chunk: Buffer,
    partNumber: number,
    rinfo: dgram.RemoteInfo,
    chunkId: string
) {
if(!chunk){
    console.log("Chunk vacio");
    return;
}

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
            }
        }
    });
};

function startChunkVerification(clientId: string, totalChunks: number, rinfo: dgram.RemoteInfo) {
    async function verifyChunks(clientId: string, rinfo: dgram.RemoteInfo) {
        let missingChunks = false;
    
        for (let attempt = 1; attempt <= 2; attempt++) {
            console.log(`Iniciando verificación #${attempt} de chunks`);
    
            for (let index = 0; index < sentChunks.size; index++) {
                console.log(`Verificando chunk: ${index}`);
                if (!ackedChunks.has(getChunkId(clientId, index))) {
                    missingChunks = true;
                    console.log(`Reenviando chunk: ${index}`);
                    const chunkId = getChunkId(clientId, index);
                    const chunkData = sentChunks.get(chunkId);
    
                    if (chunkData) {
                        sendChunk(chunkData.chunk, index, rinfo, chunkId);
                    }
                }
                // Pequeña pausa para evitar saturación del buffer
                await new Promise(resolve => setImmediate(resolve));
            }
    
            console.log(`Verificación #${attempt} de chunks completada`);
    
            if (!missingChunks) break; // Si no hay chunks faltantes, detener la verificación
    
            // Esperar antes de la segunda verificación
            if (attempt === 1) await new Promise(resolve => setTimeout(resolve, 1000));
        }
    
        // Finalizar y limpiar después de 500ms
        await new Promise(resolve => setTimeout(resolve, 500));
        server.send("", rinfo.port, rinfo.address);
        clearClientChunks(clientId);
        console.log("Chunks limpiados");
    }
    
    // Iniciar verificación
    verifyChunks(clientId, rinfo).catch(err => {
        console.error("Error en la verificación de chunks:", err);
    });
    
}

function clearClientChunks(clientId: string) {
    console.log(`Limpiando chunks de ${clientId}`);
    for (let index = 0; index <= sentChunks.size; index++) {
        const chunkId = getChunkId(clientId, index);
        sentChunks.delete(chunkId);
        ackedChunks.delete(chunkId);
    }
}

server.on("error", (err) => {
    console.log("Error en la conexión:", err);
});

server.on("listening", () => {
    console.log(`Servidor escuchando en: ${server.address().address}:${server.address().port}`);
});

server.bind(3000);