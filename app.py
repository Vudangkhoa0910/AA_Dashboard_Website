# Đặt eventlet.monkey_patch() lên đầu (QUAN TRỌNG!)
import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, jsonify, url_for
from flask_socketio import SocketIO
import paho.mqtt.client as mqtt
import msgpack
import threading
import json
import time
import base64 # <--- THÊM IMPORT NÀY
import binascii # <--- THÊM IMPORT NÀY (cho Base64 error handling)

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# --- Configuration ---
mqtt_host = "52.220.146.209"
mqtt_port = 1883
mqtt_user = "alphaasimov2024"
mqtt_pass = "gvB3DtGfus6U"
KNOWN_ROBOTS = ["embed_e6d9e2", "bulldog01_5f899b"]
ROBOT_SUB_TOPICS = [
    "robot_status", "lane_follow_cmd", "scan_multi", "gloal_path_gps",
    "camera", "routed_map", "joystick_control",
]

# --- Data Storage ---
latest_data = {
    robot_id: {sub_topic: "waiting for data..." for sub_topic in ROBOT_SUB_TOPICS}
    for robot_id in KNOWN_ROBOTS
}
data_lock = threading.Lock()

# --- MQTT Callbacks ---
def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("✅ MQTT connected successfully")
        wildcard_topic = "+/r2s/#"
        client.subscribe(wildcard_topic) 
        print(f"➡️ Subscribed to wildcard topic: {wildcard_topic}")
    else:
        print(f"❌ MQTT connection failed with code: {rc}")

def on_message(client, userdata, msg):
    payload = None
    robot_id = "unknown"
    sub_topic = "unknown"
    try:
        topic_parts = msg.topic.split('/')
        if len(topic_parts) >= 3 and topic_parts[1] == 'r2s':
            robot_id = topic_parts[0]
            sub_topic = '/'.join(topic_parts[2:])

            # Dynamic robot discovery
            if robot_id not in latest_data:
                 with data_lock:
                    if robot_id not in latest_data:
                        print(f"ℹ️ Discovered new robot: {robot_id}. Adding to data structure.")
                        latest_data[robot_id] = {st: "waiting for data..." for st in ROBOT_SUB_TOPICS}
                        socketio.emit('new_robot_discovered', robot_id)

            # --- Payload Decoding ---
            try:
                payload = msgpack.unpackb(msg.payload, raw=False)

                # ***** START IMAGE DATA HANDLING MODIFICATION *****
                image_like_topics = ['routed_map', 'camera']
                if sub_topic in image_like_topics and isinstance(payload, dict) and 'data' in payload:
                    data_field = payload['data'] # Lấy dữ liệu ra để kiểm tra

                    if isinstance(data_field, bytes):
                        # Trường hợp 1: Dữ liệu là bytes (như mong đợi) -> chuyển thành list
                        try:
                            payload['data'] = list(data_field)
                            # print(f"✅ Converted 'data' bytes to list for {robot_id}/{sub_topic}")
                        except Exception as e_conv:
                            print(f"❌ Error converting 'data' bytes to list for {robot_id}/{sub_topic}: {e_conv}")
                            payload = f"Error processing image bytes: {e_conv}" # Ghi đè payload bằng lỗi

                    elif isinstance(data_field, str):
                        # Trường hợp 2: Dữ liệu là string -> Thử giải mã Base64
                        try:
                            # Giải mã chuỗi Base64 thành bytes
                            decoded_bytes = base64.b64decode(data_field)
                            # Chuyển đổi bytes đã giải mã thành list
                            payload['data'] = list(decoded_bytes)
                        except (binascii.Error, ValueError) as e_b64:
                            # Lỗi nếu chuỗi không phải là Base64 hợp lệ
                            print(f"❌ Failed to decode 'data' string as Base64 for {robot_id}/{sub_topic}: {e_b64}. Keeping original string.")
                            # Quyết định: Giữ chuỗi gốc hay báo lỗi? Tạm thời báo lỗi rõ ràng hơn.
                            error_msg = f"Error: Image data received as string but is not valid Base64 for {sub_topic}"
                            # payload['data'] = error_msg # Cập nhật chỉ trường data
                            payload = error_msg         # Hoặc ghi đè toàn bộ payload bằng lỗi
                        except Exception as e_conv_str:
                            print(f"❌ Error converting Base64 decoded bytes to list for {robot_id}/{sub_topic}: {e_conv_str}")
                            payload = f"Error processing decoded image string: {e_conv_str}" # Ghi đè payload

                    elif not isinstance(data_field, list):
                        # Trường hợp 3: Không phải bytes, không phải string, không phải list -> Lỗi không mong đợi
                        print(f"⚠️ Unexpected type for 'data' in {robot_id}/{sub_topic}: {type(data_field)}. Expected bytes, string, or list.")
                        payload = f"Error: Unexpected data type {type(data_field).__name__} for image data in {sub_topic}" # Ghi đè payload
                    # Else: data_field đã là một list, không cần làm gì cả.

                # ***** END IMAGE DATA HANDLING MODIFICATION *****

            except (msgpack.exceptions.UnpackException, msgpack.exceptions.ExtraData) as e_msgpack:
                # Fallback to text/JSON decoding
                try:
                    payload_str = msg.payload.decode('utf-8')
                    if payload_str.strip().startswith('{') or payload_str.strip().startswith('['):
                        payload = json.loads(payload_str)
                    else:
                        payload = payload_str
                except Exception as e_decode:
                    print(f"❌ Error decoding non-msgpack payload on {msg.topic} as text/JSON: {e_decode}")
                    payload = f"Error decoding payload: {e_decode}"
            except Exception as e_unpack:
                 print(f"❌ Error unpacking msgpack payload on {msg.topic}: {e_unpack}")
                 payload = f"Error unpacking msgpack: {e_unpack}"

            # --- Data Storage and Emission ---
            # Kiểm tra xem payload có bị ghi đè bằng thông báo lỗi dạng chuỗi không
            if isinstance(payload, str) and payload.startswith("Error:"):
                 # Nếu payload là một chuỗi lỗi từ quá trình xử lý ở trên, vẫn lưu và gửi nó
                 pass # Không cần làm gì thêm ở đây, sẽ được xử lý bên dưới
            elif payload is None:
                 print(f"ℹ️ Payload is None after decoding for {robot_id}/{sub_topic}. Skipping storage/emission.")
                 return # Bỏ qua nếu payload là None

            # Lưu trữ và gửi dữ liệu (hoặc thông báo lỗi đã được gán cho payload)
            with data_lock:
                if robot_id in latest_data:
                    if sub_topic not in latest_data[robot_id]:
                         latest_data[robot_id][sub_topic] = None
                    latest_data[robot_id][sub_topic] = payload
                else:
                    print(f"⚠️ Robot ID {robot_id} not found in latest_data during storage. Message ignored.")
                    return

            socketio.emit('mqtt_data', {
                'robot_id': robot_id,
                'sub_topic': sub_topic,
                'payload': payload
            })

        else:
            # print(f"Received message on unhandled topic structure: {msg.topic}")
            pass

    except Exception as e:
        print(f"❌ [ERROR] Unexpected error in on_message for topic {getattr(msg, 'topic', 'unknown')}: {e}")
        try:
             if robot_id != "unknown" and sub_topic != "unknown":
                  with data_lock:
                       if robot_id in latest_data:
                            if sub_topic not in latest_data[robot_id]:
                                latest_data[robot_id][sub_topic] = None
                            error_msg = f"Error processing message: {e}"
                            latest_data[robot_id][sub_topic] = error_msg
                            socketio.emit('mqtt_data', {
                                'robot_id': robot_id, 'sub_topic': sub_topic,
                                'payload': error_msg
                            })
                       else:
                            print(f"❌ Cannot store error state for {msg.topic}, robot ID '{robot_id}' not tracked.")
             else:
                  print(f"❌ Cannot store error state for {getattr(msg, 'topic', 'unknown')}, invalid robot/topic info.")
        except Exception as inner_e:
             print(f"❌ Error trying to store/emit error state for {getattr(msg, 'topic', 'unknown')}: {inner_e}")

# --- MQTT Thread ---
def mqtt_thread():
    client_id = f"flask_mqtt_dashboard_{threading.get_ident()}"
    client = mqtt.Client(client_id=client_id, protocol=mqtt.MQTTv311, clean_session=True)
    client.username_pw_set(mqtt_user, mqtt_pass)
    client.on_connect = on_connect
    client.on_message = on_message

    print(f"⏳ Attempting to connect to MQTT broker at {mqtt_host}:{mqtt_port}...")
    while True:
        try:
            client.connect(mqtt_host, mqtt_port, 60)
            client.loop_forever()
            print("mqtt_thread: loop_forever exited unexpectedly. Attempting reconnect...")
        except ConnectionRefusedError:
             print(f"❌ MQTT Connection Refused. Check broker, credentials, network. Retrying in 10s...")
        except OSError as e:
             print(f"❌ MQTT Network Error: {e}. Retrying in 10s...")
        except mqtt.WebsocketConnectionError as e:
             print(f"❌ MQTT Websocket Error: {e}. Retrying in 10s...")
        except Exception as e:
            print(f"❌ Unexpected MQTT error in thread: {type(e).__name__} - {e}. Retrying in 10s...")
        finally:
            try:
                client.disconnect()
                print("MQTT client disconnected.")
            except Exception as disconnect_e:
                 print(f"ℹ️ Error during MQTT disconnect: {disconnect_e}")
            print("Attempting reconnect in 10 seconds...")
            eventlet.sleep(10)

# --- Flask Routes ---
@app.route("/")
def index():
    with data_lock:
        current_robots = list(latest_data.keys())
    return render_template("index.html",
                           known_robots=current_robots,
                           robot_sub_topics=ROBOT_SUB_TOPICS)

@app.route("/data")
def data():
    with data_lock:
        return jsonify(latest_data)

# --- SocketIO Events ---
@socketio.on('connect')
def handle_connect():
    print('✅ Client connected via SocketIO')
    with data_lock:
        socketio.emit('initial_state', {
            'known_robots': list(latest_data.keys()),
            'all_data': latest_data,
            'robot_sub_topics': ROBOT_SUB_TOPICS
        })

@socketio.on('disconnect')
def handle_disconnect():
    print('❌ Client disconnected via SocketIO')

# --- Main Execution ---
if __name__ == '__main__':
    print("🚀 Starting Flask-SocketIO server...")
    mqtt_thread_obj = threading.Thread(target=mqtt_thread, daemon=True)
    mqtt_thread_obj.start()
    print(f"📈 Dashboard available at http://0.0.0.0:5001")
    socketio.run(app, host="0.0.0.0", port=5001, debug=False)