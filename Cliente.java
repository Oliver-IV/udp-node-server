public class Client {
    private DatagramSocket socket;
    private InetAddress address;
    private int port;
    private final String outputPath = "src/main/received/";
    private final Gson gson = new Gson();
    private final int TIMEOUT = 1000; // 1 segundo

    private void sendAck(Data packet) throws IOException {
        Data ack = new Data();
        ack.setContentType("ack");
        ack.setPart(packet.getPart());
        ack.setContent(packet.getContent());
        String json = gson.toJson(ack);
        byte[] bytes = json.getBytes();
        DatagramPacket ackPacket = new DatagramPacket(bytes, bytes.length, address, port);
        socket.send(ackPacket);
    }

    private Data receive() throws IOException {
        byte[] data = new byte[1024];
        DatagramPacket packet = new DatagramPacket(data, data.length);
        
        try {
            socket.receive(packet);
            
            if (packet.getLength() == 0) {
                return null;
            }
            
            String json = new String(packet.getData(), 0, packet.getLength());
            Data dataReceived = gson.fromJson(json, Data.class);
            
            // Enviar ACK para paquetes de tipo filePart
            if (dataReceived != null && "filePart".equals(dataReceived.getContentType())) {
                sendAck(dataReceived);
            }
            
            return dataReceived;
        } catch (SocketTimeoutException e) {
            return null;
        }
    }

    public void askForFiles(String host, int port) throws IOException {
        socket = new DatagramSocket();
        socket.setSoTimeout(TIMEOUT);
        Data data = new Data();
        data.setContentType(Data.FILE_PATHS);
        String json = gson.toJson(data);
        byte[] bytes = json.getBytes();
        this.port = port;
        address = InetAddress.getByName(host);
        DatagramPacket packet = new DatagramPacket(bytes, bytes.length, address, this.port);
        socket.send(packet);

        receiveFileNames();
        socket.close();
    }

    private List<Data> catchFileParts(int numPackets) throws IOException {
        Data dataReceived;
        List<Data> packets = new ArrayList<>();
        Map<Integer, Boolean> receivedParts = new HashMap<>();
        long startTime = System.currentTimeMillis();
        
        while (true) {
            // Verificar si se han recibido todos los paquetes
            if (packets.size() == numPackets) {
                break;
            }
            
            // Timeout general de 30 segundos
            if (System.currentTimeMillis() - startTime > 30000) {
                System.out.println("Timeout general alcanzado");
                break;
            }
            
            dataReceived = receive();
            
            if (dataReceived == null) {
                continue;
            }
            
            int partNumber = dataReceived.getPart();
            
            // Evitar duplicados
            if (!receivedParts.containsKey(partNumber)) {
                packets.add(dataReceived);
                receivedParts.put(partNumber, true);
                System.out.println("Recibido paquete #" + (partNumber + 1) + " de " + numPackets);
            }
        }

        System.out.println("Recibidos " + packets.size() + " de " + numPackets + " paquetes");
        return packets;
    }

    // Los demás métodos permanecen igual...
}