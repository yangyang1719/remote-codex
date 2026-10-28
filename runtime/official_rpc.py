"""Short-lived, stdlib WebSocket client for the official Unix app-server API."""
import base64
import hashlib
import json
import os
import socket
import struct


class RPC:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(20)
        self.sock.connect(str(path))
        self.sequence = 0
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: '+key+'\r\n\r\n').encode())
        header = bytearray()
        while not header.endswith(b'\r\n\r\n'):
            header.extend(self.exact(1))
            if len(header) > 16384: raise RuntimeError('Oversize WebSocket handshake')
        lines = header.decode('ascii').split('\r\n')
        fields = {k.lower(): v.strip() for line in lines[1:] if ':' in line for k,v in [line.split(':',1)]}
        expected = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        if not lines[0].startswith('HTTP/1.1 101 ') or fields.get('sec-websocket-accept') != expected: raise RuntimeError('Invalid official WebSocket handshake')
        self.request('initialize', {'clientInfo': {'name': 'remote_codex_service_control', 'version': '0.3.0'}, 'capabilities': {'experimentalApi': True}})
        self.send({'method': 'initialized', 'params': {}})

    def exact(self, size):
        data = bytearray()
        while len(data) < size:
            part = self.sock.recv(size-len(data))
            if not part: raise ConnectionError('Official app-server disconnected')
            data.extend(part)
        return bytes(data)

    def frame(self, data, opcode=1):
        length = len(data); mask = os.urandom(4)
        prefix = bytes([128|opcode,128|length]) if length < 126 else bytes([128|opcode,254])+struct.pack('!H',length) if length < 65536 else bytes([128|opcode,255])+struct.pack('!Q',length)
        self.sock.sendall(prefix+mask+bytes(v^mask[i%4] for i,v in enumerate(data)))

    def send(self, value):
        self.frame(json.dumps(value, ensure_ascii=False).encode())

    def request(self, method, params=None):
        self.sequence += 1; identifier = 'admin-'+str(self.sequence)
        self.send({'id': identifier, 'method': method, 'params': params or {}})
        fragments = bytearray()
        while True:
            h = self.exact(2); opcode, length = h[0]&15,h[1]&127
            if h[1]&128 or h[0]&112: raise RuntimeError('Invalid server frame')
            if length == 126: length = struct.unpack('!H', self.exact(2))[0]
            elif length == 127: length = struct.unpack('!Q', self.exact(8))[0]
            if length > 32000000 or len(fragments)+length > 32000000: raise RuntimeError('Oversize response')
            data = self.exact(length)
            if opcode == 8: raise ConnectionError('Official app-server closed')
            if opcode == 9: self.frame(data,10); continue
            if opcode == 10: continue
            if opcode not in (0,1): raise RuntimeError('Unsupported server frame')
            fragments.extend(data)
            if not h[0]&128: continue
            value = json.loads(fragments); fragments.clear()
            if value.get('id') == identifier and 'method' not in value:
                if 'error' in value: raise RuntimeError(value['error'].get('message','Official RPC error'))
                return value.get('result', {})
            if 'id' in value and 'method' in value:
                # This helper never subscribes/resumes or approves model requests.
                self.send({'id': value['id'], 'error': {'code': -32601, 'message': 'Service control cannot approve tool requests'}})

    def close(self):
        self.sock.close()

    def __enter__(self): return self
    def __exit__(self, *args): self.close()
