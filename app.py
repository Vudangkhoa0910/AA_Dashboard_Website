# -*- coding: utf-8 -*-
# Đặt eventlet.monkey_patch() lên đầu (QUAN TRỌNG!)
import eventlet
eventlet.monkey_patch()

from flask import Flask, render_template, jsonify, url_for, request
from flask_socketio import SocketIO
import paho.mqtt.client as mqtt
import msgpack
import threading
import json
import time
import base64
import binascii
import copy # For deep copying data
import logging # Use logging module
import signal # To handle graceful shutdown
import sys

# --- Logging Setup ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
log = logging.getLogger('DashboardApp')
# Reduce log level for libraries if too noisy
logging.getLogger('paho').setLevel(logging.WARNING)
logging.getLogger('engineio').setLevel(logging.WARNING)
logging.getLogger('socketio').setLevel(logging.WARNING)
# --- ADDED: More detailed debug for bulldog ---
# logging.getLogger('DashboardApp').setLevel(logging.DEBUG) # Uncomment for very detailed logs

# --- Flask & SocketIO Setup ---
app = Flask(__name__)
# !!! THAY ĐỔI SECRET KEY CHO PRODUCTION !!!
app.config['SECRET_KEY'] = 'a_very_secret_key_change_this_12345!'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet', logger=False, engineio_logger=False)

# --- Configuration ---
MQTT_HOST = "52.220.146.209"
MQTT_PORT = 1883
MQTT_USER = "alphaasimov2024"
MQTT_PASS = "gvB3DtGfus6U"
MQTT_LISTENER_CLIENT_ID = f"dashboard_listener_{int(time.time())}"
MQTT_PUBLISHER_CLIENT_ID_PREFIX = "dashboard_publisher_"
MQTT_KEEPALIVE = 60
MQTT_RECONNECT_DELAY = 15 # seconds

# --- !!! DEFINE YOUR ROBOTS HERE !!! ---
# Robot IDs should match the format: {username}_{mac_id}
KNOWN_ROBOTS = ["embed_e6d9e2", "bulldog01_5f899b", "sim_robot_1", "sim_robot_2"]
log.info(f"Managing known robots: {KNOWN_ROBOTS}")

# Expected sub-topics
ROBOT_SUB_TOPICS_R2S = [
    "robot_status", "lane_follow_cmd", "scan_multi", "gloal_path_gps",
    "camera", "routed_map",
]
ROBOT_SUB_TOPICS_S2R = ["joystick_control", "server_cmd"]
ALL_EXPECTED_SUB_TOPICS = list(set(ROBOT_SUB_TOPICS_R2S + ROBOT_SUB_TOPICS_S2R))

# --- Data Storage ---
latest_data = {}
data_lock = threading.Lock()
mqtt_listener_thread_obj = None
stop_event = threading.Event()

# --- Initialization ---
def initialize_robot_data():
    log.info("Initializing data structure for known robots...")
    with data_lock:
        for robot_id in KNOWN_ROBOTS:
            if robot_id not in latest_data:
                latest_data[robot_id] = {
                    'last_seen': 0,
                    'topics': {
                        topic: {'payload': "waiting...", 'timestamp': 0}
                        for topic in ALL_EXPECTED_SUB_TOPICS
                    }
                }
    log.info(f"Data structure initialized. Robots managed: {list(latest_data.keys())}")

# --- MQTT Callbacks ---
def on_connect(client, userdata, flags, rc):
    if rc == 0:
        log.info("✅ MQTT Listener connected successfully.")
        topic_to_subscribe = "+/r2s/#"
        client.subscribe(topic_to_subscribe, qos=0)
        log.info(f"➡️ MQTT Listener subscribed to: {topic_to_subscribe}")
    else:
        log.error(f"❌ MQTT Listener connection failed. Code: {rc}. Check broker address/port/credentials.")

def on_disconnect(client, userdata, rc):
    if rc != 0:
        log.warning(f"🔌 MQTT Listener unexpectedly disconnected. Code: {rc}. Reconnection will be attempted by the loop.")

def on_message(client, userdata, msg):
    if stop_event.is_set():
        return

    payload = None
    robot_id = "unknown"
    direction = "unknown"
    sub_topic = "unknown"
    current_time_ms = int(time.time() * 1000)
    is_error_payload = False # Flag to indicate if payload processing resulted in an error string
    is_target_topic = False # Flag for bulldog/routed_map

    try:
        topic = msg.topic
        # --- ADDED: Log every incoming message's topic ---
        # log.debug(f"MQTT Received: {topic}")

        topic_parts = topic.split('/')
        if len(topic_parts) >= 3:
            robot_id = topic_parts[0]
            direction = topic_parts[1]
            sub_topic = '/'.join(topic_parts[2:])

            # --- ADDED: Check if this is the target topic for logging ---
            if robot_id == 'bulldog01_5f899b' and sub_topic == 'routed_map':
                is_target_topic = True
                log.info(f"--- Processing TARGET topic: {topic} ---")

            if direction != 'r2s' or robot_id not in KNOWN_ROBOTS:
                return

            # --- Payload Decoding ---
            try:
                payload = msgpack.unpackb(msg.payload, raw=False)
                if is_target_topic:
                    log.info(f"✅ TARGET Decoded (msgpack): Payload type={type(payload)}")
                    # --- ADDED: Log structure if it's a dict ---
                    if isinstance(payload, dict):
                        log.info(f"   Payload Keys: {list(payload.keys())}")
                        if 'data' in payload:
                            log.info(f"   Initial 'data' field type: {type(payload['data']).__name__}, Len/Val: {str(payload['data'])[:100]}...") # Show first 100 chars/bytes
                        else:
                            log.info("   'data' field MISSING initially.")
                    elif isinstance(payload, list):
                         log.info(f"   Payload is a list, length: {len(payload)}")
                    else:
                         log.info(f"   Payload value (partial): {str(payload)[:100]}...")


            except (msgpack.exceptions.UnpackException, msgpack.exceptions.ExtraData) as e_mp:
                if is_target_topic: log.warning(f"⚠️ TARGET Not msgpack: {e_mp}")
                try:
                    payload_str = msg.payload.decode('utf-8')
                    if payload_str.strip().startswith(('{', '[')):
                        payload = json.loads(payload_str)
                        if is_target_topic:
                            log.info(f"✅ TARGET Decoded (JSON): Payload type={type(payload)}")
                            if isinstance(payload, dict):
                                log.info(f"   Payload Keys: {list(payload.keys())}")
                                if 'data' in payload:
                                    log.info(f"   Initial 'data' field type: {type(payload['data']).__name__}, Len/Val: {str(payload['data'])[:100]}...")
                                else:
                                     log.info("   'data' field MISSING initially.")
                            elif isinstance(payload, list):
                                 log.info(f"   Payload is a list, length: {len(payload)}")
                            else:
                                log.info(f"   Payload value (partial): {str(payload)[:100]}...")
                    else:
                        payload = payload_str # Keep as string if not JSON
                        if is_target_topic:
                             log.info(f"✅ TARGET Decoded (UTF-8 String): Payload is string. Value (partial): {payload[:100]}...")

                except Exception as e_decode:
                    payload = f"Error: Cannot decode payload (not msgpack/json/utf8)"
                    log.warning(f"DecodeErr: {robot_id}/{sub_topic}: {e_decode}. Payload: {msg.payload[:60]}...")
                    if is_target_topic: log.error(f"❌ TARGET Decode FAILED.")
                    is_error_payload = True
            except Exception as e_unpack:
                 payload = f"Error: Failed to unpack msgpack payload"
                 log.error(f"UnpackErr: {robot_id}/{sub_topic}: {e_unpack}")
                 if is_target_topic: log.error(f"❌ TARGET Msgpack Unpack FAILED: {e_unpack}")
                 is_error_payload = True

            # --- Image Data Handling (More Robust) ---
            image_like_topics = ['routed_map', 'camera']
            if sub_topic in image_like_topics and not is_error_payload: # Only process if initial decode worked
                if is_target_topic: log.info(f"--- TARGET: Entering Image Handling ---")
                # Check if payload looks like a ROS Image message structure
                if isinstance(payload, dict) and all(k in payload for k in ['width', 'height', 'encoding', 'data']):
                    data_field = payload.get('data')
                    original_data_type = type(data_field)
                    converted_data = None
                    if is_target_topic: log.info(f"   Image structure OK. Initial 'data' type: {original_data_type.__name__}")

                    try:
                        if isinstance(data_field, bytes):
                            converted_data = list(data_field)
                            if is_target_topic: log.info(f"   Converted bytes -> list (len={len(converted_data)})")
                        elif isinstance(data_field, str):
                            try:
                                decoded_bytes = base64.b64decode(data_field, validate=True)
                                converted_data = list(decoded_bytes)
                                if is_target_topic: log.info(f"   Converted base64 string -> list (len={len(converted_data)})")
                            except (binascii.Error, ValueError) as e_b64:
                                payload = f"Error: Invalid Base64 data in image"
                                log.warning(f"ImgConvErrB64: {robot_id}/{sub_topic}: {e_b64}")
                                if is_target_topic: log.error(f"   ❌ TARGET Base64 decode FAILED: {e_b64}")
                                is_error_payload = True
                        elif isinstance(data_field, list):
                            converted_data = data_field # Use as is
                            if is_target_topic: log.info(f"   Data already a list (len={len(converted_data)}). Using as is.")
                        elif isinstance(data_field, tuple):
                            converted_data = list(data_field) # Convert tuple to list
                            if is_target_topic: log.info(f"   Converted tuple -> list (len={len(converted_data)})")
                        else:
                            payload = f"Error: Unexpected data type '{original_data_type.__name__}' in image data field"
                            log.warning(f"ImgConvErrType: {robot_id}/{sub_topic} - Unexpected type: {original_data_type}")
                            if is_target_topic: log.error(f"   ❌ TARGET Unexpected data type: {original_data_type.__name__}")
                            is_error_payload = True

                        # If conversion was successful, update the payload
                        if converted_data is not None and not is_error_payload:
                            payload['data'] = converted_data
                            if is_target_topic: log.info(f"   ✅ TARGET Image data successfully set to list.")
                        elif is_error_payload and is_target_topic:
                             log.error(f"   ❌ TARGET Image data conversion resulted in error. Payload set to error string.")


                    except Exception as e_conv:
                         payload = f"Error: Exception during image data conversion"
                         log.error(f"ImgConvErrGeneric: {robot_id}/{sub_topic}: {e_conv}")
                         if is_target_topic: log.error(f"   ❌ TARGET Generic conversion exception: {e_conv}")
                         is_error_payload = True

                elif isinstance(payload, dict): # Is a dict, but NOT the expected structure
                     payload = f"Error: Image message structure incorrect (missing keys?)"
                     log.warning(f"ImgStructErr: {robot_id}/{sub_topic} - Keys: {list(payload.keys())}")
                     if is_target_topic: log.error(f"   ❌ TARGET Image structure incorrect. Keys: {list(payload.keys())}")
                     is_error_payload = True
                elif is_target_topic: # Not a dict, not an image structure we handle
                    log.warning(f"   Payload is not a dict, cannot process as standard image structure. Type: {type(payload).__name__}")
                if is_target_topic: log.info(f"--- TARGET: Exiting Image Handling ---")


            # --- Data Storage & Emission ---
            if payload is None: # Should not happen with current logic, but safety check
                if is_target_topic: log.error("CRITICAL: Payload is None before storage!")
                return

            data_to_store = {'payload': payload, 'timestamp': current_time_ms}

            # --- ADDED: Log final payload before sending to frontend ---
            if is_target_topic:
                 final_payload_type = type(payload)
                 final_data_field_type = "N/A"
                 final_data_field_len = "N/A"
                 if isinstance(payload, dict) and 'data' in payload:
                     final_data_field_type = type(payload['data']).__name__
                     if hasattr(payload['data'], '__len__'):
                        final_data_field_len = len(payload['data'])
                 log.info(f"--- TARGET: Final Check Before Emit ---")
                 log.info(f"   Final Payload Type: {final_payload_type.__name__}")
                 if isinstance(payload, dict):
                     log.info(f"   Final Keys: {list(payload.keys())}")
                     log.info(f"   Final 'data' field Type: {final_data_field_type}")
                     log.info(f"   Final 'data' field Len: {final_data_field_len}")
                     log.info(f"   Other fields: w={payload.get('width')}, h={payload.get('height')}, enc={payload.get('encoding')}")
                 elif isinstance(payload, str) and is_error_payload:
                      log.info(f"   Final Payload is ERROR string: {payload}")
                 else:
                      log.info(f"   Final Payload value (partial): {str(payload)[:100]}...")
                 log.info(f"   Is Error Payload Flag: {is_error_payload}")
                 log.info(f"---------------------------------------")


            # Lock and store/emit
            with data_lock:
                if robot_id in latest_data:
                    if 'topics' not in latest_data[robot_id]: latest_data[robot_id]['topics'] = {}
                    latest_data[robot_id]['topics'][sub_topic] = copy.deepcopy(data_to_store) # Deep copy stored data
                    latest_data[robot_id]['last_seen'] = current_time_ms
                else:
                    log.error(f"CRITICAL: Attempted to store data for {robot_id} which is not in latest_data structure!")
                    return

            # Use the original data_to_store for emit (avoids deep copying cost again)
            socketio.emit('mqtt_data', {
                'robot_id': robot_id,
                'sub_topic': sub_topic,
                'data': data_to_store, # Send the original dict containing payload+timestamp
                'robot_last_seen': current_time_ms
            })
            # log.debug(f"Processed: {robot_id}/{sub_topic}")

    except Exception as e:
        log.exception(f"CRITICAL error in on_message processing topic {getattr(msg, 'topic', 'unknown')}: {e}")
        if is_target_topic: log.error(f"--- TARGET: CRITICAL error in on_message: {e} ---")

# --- MQTT Listener Thread ---
# (Giữ nguyên phần còn lại của mqtt_listener_thread_func)
def mqtt_listener_thread_func():
    """Function containing the MQTT listener loop."""
    listener_client = None
    log.info("MQTT Listener thread started.")
    while not stop_event.is_set():
        try:
            listener_client = mqtt.Client(client_id=MQTT_LISTENER_CLIENT_ID, protocol=mqtt.MQTTv311, clean_session=True)
            listener_client.username_pw_set(MQTT_USER, MQTT_PASS)
            listener_client.on_connect = on_connect
            listener_client.on_message = on_message
            listener_client.on_disconnect = on_disconnect

            log.info(f"MQTT Listener: Attempting connection to {MQTT_HOST}:{MQTT_PORT}...")
            listener_client.connect(MQTT_HOST, MQTT_PORT, MQTT_KEEPALIVE)
            listener_client.loop_forever()
            if not stop_event.is_set():
                 log.warning("MQTT Listener: loop_forever exited unexpectedly. Will retry connection cycle.")

        except ConnectionRefusedError:
             log.error(f"MQTT Listener: Connection Refused. Retrying in {MQTT_RECONNECT_DELAY}s...")
        except OSError as e:
             log.error(f"MQTT Listener: Network Error: {e}. Retrying in {MQTT_RECONNECT_DELAY}s...")
        except Exception as e:
            log.exception(f"MQTT Listener: Unexpected error in connection/loop setup: {e}. Retrying in {MQTT_RECONNECT_DELAY}s...")
        finally:
            if listener_client and listener_client.is_connected():
                try: listener_client.disconnect()
                except Exception: pass
            if not stop_event.is_set():
                 stop_event.wait(timeout=MQTT_RECONNECT_DELAY)

    log.info("MQTT Listener thread finished.")


# --- Flask Routes ---
# (Giữ nguyên các route / và /data)
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/data")
@app.route("/data/<robot_id>")
def data_endpoint(robot_id=None):
    with data_lock:
        if robot_id:
            if robot_id in latest_data:
                return jsonify(copy.deepcopy(latest_data[robot_id]))
            else:
                return jsonify({"error": "Robot not found"}), 404
        else:
            return jsonify(copy.deepcopy(latest_data))


# --- SocketIO Events ---
# (Giữ nguyên các event connect, disconnect, send_command)
@socketio.on('connect')
def handle_connect():
    sid = request.sid
    log.info(f'✅ Client connected via SocketIO (SID: {sid})')
    with data_lock:
        # Use deepcopy when sending initial state to avoid modifying shared data
        initial_state = {
            'known_robots': KNOWN_ROBOTS,
            'all_data': copy.deepcopy(latest_data),
            'robot_sub_topics': ALL_EXPECTED_SUB_TOPICS
        }
    socketio.emit('initial_state', initial_state, room=sid)

@socketio.on('disconnect')
def handle_disconnect():
    log.info(f'❌ Client disconnected via SocketIO (SID: {request.sid})')

@socketio.on('send_command')
def handle_send_command(data):
    if stop_event.is_set():
         socketio.emit('command_feedback', {'status': 'error', 'message': 'Server shutting down.'}, room=request.sid)
         return

    sid = request.sid
    robot_id = data.get('robot_id')
    command_type = data.get('command_type')
    payload_dict = data.get('payload')

    if not robot_id or robot_id not in KNOWN_ROBOTS:
        log.warning(f"Invalid command: Unknown robot_id '{robot_id}' from {sid}.")
        socketio.emit('command_feedback', {'status': 'error', 'message': f'Invalid robot ID: {robot_id}.'}, room=sid)
        return
    if not command_type or not isinstance(payload_dict, dict):
        log.warning(f"Invalid command format from {sid} for {robot_id}: type={command_type}, payload_type={type(payload_dict)}")
        socketio.emit('command_feedback', {'status': 'error', 'message': 'Invalid command format.'}, room=sid)
        return

    topic_to = f"{robot_id}/s2r/{command_type}"

    # Log the topic being published to for debugging
    log.info(f"📤 Publishing command '{command_type}' to topic: {topic_to}")
    log.info(f"📋 Payload structure: {payload_dict}")

    try:
        # Ensure payload uses bytes where appropriate for msgpack
        serialized_payload = msgpack.dumps(payload_dict, use_bin_type=True)
        log.info(f"📦 Serialized payload size: {len(serialized_payload)} bytes")
    except Exception as e:
        log.exception(f"Serialization Error for {topic_to}: {e}")
        socketio.emit('command_feedback', {'status': 'error', 'message': f'Serialization Error: {e}'}, room=sid)
        return

    publisher_client = None
    try:
        pub_client_id = f"{MQTT_PUBLISHER_CLIENT_ID_PREFIX}{sid}_{int(time.time()*1000)}"
        publisher_client = mqtt.Client(client_id=pub_client_id, protocol=mqtt.MQTTv311)
        publisher_client.username_pw_set(MQTT_USER, MQTT_PASS)
        # Short connect timeout for publishing
        publisher_client.connect(MQTT_HOST, MQTT_PORT, 5)
        publisher_client.loop_start() # Start network loop for callbacks

        # Publish the message
        msg_info = publisher_client.publish(topic_to, serialized_payload, qos=0) # qos=0 for fire-and-forget
        msg_info.wait_for_publish(timeout=1) # Wait briefly for acknowledgment (best effort with qos=0)

        if msg_info.rc == mqtt.MQTT_ERR_SUCCESS:
             log.info(f"✅ Command '{command_type}' published to {topic_to} ({len(serialized_payload)} bytes).")
             # Feedback to the specific client that sent the command
             socketio.emit('command_feedback', {'status': 'success', 'message': f'{command_type} command sent to {robot_id}.'}, room=sid)
        else:
             log.warning(f"⚠️ Publish command to {topic_to} may have failed (rc={msg_info.rc}).")
             socketio.emit('command_feedback', {'status': 'warning', 'message': f'Command publish failed (rc={msg_info.rc}) for {robot_id}.'}, room=sid)

    except ConnectionRefusedError:
        log.error(f"MQTT Publisher: Connection Refused for {topic_to}.")
        socketio.emit('command_feedback', {'status': 'error', 'message': 'MQTT Connection Refused (Publisher).'}, room=sid)
    except OSError as e:
        log.error(f"MQTT Publisher: Network Error for {topic_to}: {e}")
        socketio.emit('command_feedback', {'status': 'error', 'message': f'MQTT Network Error (Publisher): {e}.'}, room=sid)
    except Exception as e:
        log.exception(f"MQTT Publisher: Unexpected error publishing command to {topic_to}: {e}")
        socketio.emit('command_feedback', {'status': 'error', 'message': f'Publishing Error: {e}'}, room=sid)
    finally:
        if publisher_client:
            try:
                publisher_client.loop_stop() # Stop network loop
                publisher_client.disconnect()
            except Exception: pass # Ignore errors during cleanup


# --- Graceful Shutdown Handling ---
# (Giữ nguyên signal_handler)
def signal_handler(signum, frame):
    log.info("Shutdown signal received. Stopping threads and server...")
    stop_event.set()
    global mqtt_listener_thread_obj
    if mqtt_listener_thread_obj and mqtt_listener_thread_obj.is_alive():
        log.info("Signaled MQTT listener thread to stop...")
        # No need to explicitly disconnect client here, loop_forever exit should handle it
        time.sleep(0.5) # Give thread a moment to exit loop
    log.info("Attempting graceful server shutdown...")
    # Flask-SocketIO doesn't have a specific shutdown function like Flask's dev server
    # rely on the signal terminating the process after cleanup.

# --- Main Execution ---
# (Giữ nguyên phần __main__)
if __name__ == '__main__':
    initialize_robot_data()
    log.info("🚀 Starting Dashboard Application...")
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    mqtt_listener_thread_obj = threading.Thread(target=mqtt_listener_thread_func, name="MQTTListenerThread", daemon=True)
    mqtt_listener_thread_obj.start()

    # Get port from environment variable (for deployment platforms)
    import os
    port = int(os.environ.get('PORT', 5000))
    host = '0.0.0.0'
    
    log.info(f"📈 Dashboard available at http://{host}:{port}")
    try:
        # Use socketio.run for deployment compatibility
        socketio.run(app, host=host, port=port, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        log.info("KeyboardInterrupt received. Shutting down...")
        signal_handler(signal.SIGINT, None) # Trigger graceful shutdown
    except SystemExit:
        log.info("SystemExit caught, likely from shutdown signal. Exiting.")
    finally:
        log.info("Application exiting.")
        # Ensure thread is joined after server stops
        if mqtt_listener_thread_obj and mqtt_listener_thread_obj.is_alive():
             log.info("Waiting for MQTT listener thread to join...")
             mqtt_listener_thread_obj.join(timeout=2.0)
             if mqtt_listener_thread_obj.is_alive():
                  log.warning("MQTT listener thread did not exit cleanly.")