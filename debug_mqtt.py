#!/usr/bin/env python
# -*- coding: utf-8 -*-

def send_test_command(client, robot_id):
    """Send a test server command to robot"""
    topic = f"{robot_id}/s2r/server_cmd"  # Đổi thành server_cmd
    payload = {
        "operation_mode": 2,  # Auto mode như trong script ROS
        "drive_tele_mode": 0,  # 0 = tắt điều khiển từ xa
        "server_cmd_state": 2,  # 2 = gửi vị trí mới
        "confirmation": 0,
        "store_location": {"x": 21.0285, "y": 105.8542, "z": 0.0},
        "customer_location": {"x": 21.0295, "y": 105.8552, "z": 0.0},
        "open_lid_cmd": 0,  # 0 = không mở nắp
        "emb_map": "OCP",  # Giống như trong script ROS
        "tele_cmd_vel": {
            "linear": {"x": 0.0, "y": 0.0, "z": 0.0},
            "angular": {"x": 0.0, "y": 0.0, "z": 0.0}
        }
    }.mqtt.client as mqtt
import msgpack
import json
import time

# Configuration
MQTT_HOST = "52.220.146.209"
MQTT_PORT = 1883
MQTT_USER = "alphaasimov2024"
MQTT_PASS = "gvB3DtGfus6U"

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("✅ Connected to MQTT broker")
        # Subscribe to all robot topics to see what's happening
        client.subscribe("+/+/#")
        print("📡 Subscribed to all robot topics")
    else:
        print(f"❌ Connection failed with code {rc}")

def on_message(client, userdata, msg):
    try:
        topic = msg.topic
        print(f"📨 Received topic: {topic}")
        
        # Try to decode payload
        try:
            payload = msgpack.unpackb(msg.payload, raw=False)
            print(f"📦 Payload (msgpack): {payload}")
        except:
            try:
                payload = json.loads(msg.payload.decode('utf-8'))
                print(f"📦 Payload (json): {payload}")
            except:
                payload = msg.payload.decode('utf-8', errors='ignore')
                print(f"📦 Payload (raw): {payload}")
    except Exception as e:
        print(f"❌ Error processing message: {e}")

def send_test_command(client, robot_id):
    """Send a test server command to robot"""
    topic = f"{robot_id}/s2r/server_cmd"  # Đổi thành server_cmd
    payload = {
        "operation_mode": 2,  # Auto mode như trong script ROS
        "drive_tele_mode": 0,  # 0 = tắt điều khiển từ xa
        "server_cmd_state": 2,  # 2 = gửi vị trí mới
        "confirmation": 0,
        "store_location": {"x": 21.0285, "y": 105.8542, "z": 0.0},
        "customer_location": {"x": 21.0295, "y": 105.8552, "z": 0.0},
        "open_lid_cmd": 0,  # 0 = không mở nắp
        "emb_map": "OCP",  # Giống như trong script ROS
        "tele_cmd_vel": {
            "linear": {"x": 0.0, "y": 0.0, "z": 0.0},
            "angular": {"x": 0.0, "y": 0.0, "z": 0.0}
        }
    }
    
    print(f"📤 Sending test command to topic: {topic}")
    print(f"📋 Payload: {payload}")
    
    serialized = msgpack.dumps(payload, use_bin_type=True)
    result = client.publish(topic, serialized)
    
    if result.rc == mqtt.MQTT_ERR_SUCCESS:
        print(f"✅ Command sent successfully")
    else:
        print(f"❌ Failed to send command, rc: {result.rc}")

def main():
    client = mqtt.Client()
    client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.on_connect = on_connect
    client.on_message = on_message
    
    print(f"🔗 Connecting to MQTT broker at {MQTT_HOST}:{MQTT_PORT}")
    
    try:
        connect_result = client.connect(MQTT_HOST, MQTT_PORT, 60)
        print(f"📡 Connect result: {connect_result}")
        
        # Start loop in background
        client.loop_start()
        
        # Wait for connection
        print("⏳ Waiting for connection...")
        time.sleep(3)
        
        # Send test command
        robot_id = "bulldog01_5f899b"
        print(f"📤 Sending test SERVER_CMD to {robot_id}")
        send_test_command(client, robot_id)
        
        # Keep listening for messages
        print("🔍 Listening for messages... Press Ctrl+C to exit")
        while True:
            time.sleep(1)
            
    except KeyboardInterrupt:
        print("\n👋 Stopping MQTT debug...")
        client.loop_stop()
        client.disconnect()
    except Exception as e:
        print(f"❌ Error: {e}")
        client.loop_stop()
        client.disconnect()

if __name__ == "__main__":
    main()
