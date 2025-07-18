#!/usr/bin/env python
# -*- coding: utf-8 -*-

import paho.mqtt.client as mqtt
import msgpack
import json
import time

# Configuration
MQTT_HOST = "52.220.146.209"
MQTT_PORT = 1883
MQTT_USER = "alphaasimov2024"
MQTT_PASS = "gvB3DtGfus6U"

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
    
    print(f"📤 Gửi lệnh server_cmd đến topic: {topic}")
    print(f"📋 Payload: {json.dumps(payload, indent=2)}")
    
    # Serialize payload với msgpack
    serialized_payload = msgpack.dumps(payload, use_bin_type=True)
    print(f"📦 Serialized payload size: {len(serialized_payload)} bytes")
    
    # Publish message
    result = client.publish(topic, serialized_payload, qos=0)
    if result.rc == mqtt.MQTT_ERR_SUCCESS:
        print(f"✅ Lệnh server_cmd đã gửi thành công!")
    else:
        print(f"❌ Gửi lệnh thất bại với code: {result.rc}")

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
                print(f"📦 Payload (raw): {msg.payload}")
        
        print("-" * 50)
    except Exception as e:
        print(f"❌ Error processing message: {e}")

def main():
    # Create MQTT client
    client = mqtt.Client()
    client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.on_connect = on_connect
    client.on_message = on_message
    
    # Connect to MQTT broker
    print(f"🔗 Connecting to MQTT broker at {MQTT_HOST}:{MQTT_PORT}")
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    
    # Start loop in background
    client.loop_start()
    
    # Wait for connection
    time.sleep(2)
    
    # Send test command
    robot_id = "bulldog01_5f899b"
    print(f"\n🤖 Gửi lệnh test server_cmd cho robot: {robot_id}")
    send_test_command(client, robot_id)
    
    # Wait for responses
    print("\n⏳ Chờ phản hồi trong 10 giây...")
    time.sleep(10)
    
    # Disconnect
    client.loop_stop()
    client.disconnect()
    print("\n👋 Đã ngắt kết nối MQTT")

if __name__ == "__main__":
    main()
