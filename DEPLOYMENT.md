# Hướng dẫn Deploy Alpha Asimov Dashboard

## 🚀 Các Platform Deploy Miễn Phí

### 1. HEROKU (Khuyến nghị cho ứng dụng này)

**Lưu ý:** Heroku không còn miễn phí từ 2022, nhưng có gói trial 7 ngày.

1. **Cài đặt Heroku CLI:**
   ```bash
   # macOS
   brew tap heroku/brew && brew install heroku
   ```

2. **Khởi tạo và deploy:**
   ```bash
   # Login Heroku
   heroku login
   
   # Tạo app mới
   heroku create your-app-name
   
   # Thiết lập buildpack Python
   heroku buildpacks:set heroku/python
   
   # Push code
   git add .
   git commit -m "Deploy to Heroku"
   git push heroku main
   
   # Xem logs
   heroku logs --tail
   ```

### 2. RAILWAY (Khuyến nghị - Có tier miễn phí)

1. **Truy cập [Railway.app](https://railway.app)**
2. **Connect GitHub repository**
3. **Deploy từ GitHub:**
   - Select repository
   - Railway sẽ tự động detect Python project
   - Tự động build và deploy

### 3. RENDER (Có tier miễn phí)

1. **Truy cập [Render.com](https://render.com)**
2. **Tạo Web Service mới:**
   - Connect GitHub repo
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `gunicorn -k eventlet -w 1 app:app`

### 4. FLY.IO (Có tier miễn phí)

1. **Cài đặt Fly CLI:**
   ```bash
   # macOS
   brew install flyctl
   ```

2. **Deploy:**
   ```bash
   # Login
   fly auth login
   
   # Khởi tạo app
   fly launch
   
   # Deploy
   fly deploy
   ```

## ⚠️ Lưu ý quan trọng

### Environment Variables cần thiết:
- `PORT`: Port để chạy app (tự động set bởi platform)
- `MQTT_HOST`: Địa chỉ MQTT broker (hiện tại: 52.220.146.209)
- `MQTT_USER`: Username MQTT
- `MQTT_PASS`: Password MQTT

### Cho các platform khác Heroku:
Thêm environment variables trong dashboard của platform:
```
MQTT_HOST=52.220.146.209
MQTT_USER=alphaasimov2024
MQTT_PASS=gvB3DtGfus6U
```

## 🔧 Files đã được tạo cho deployment:

- `runtime.txt`: Phiên bản Python
- `requirements.txt`: Dependencies (đã pin version)
- `Procfile`: Config cho Heroku
- `Dockerfile`: Config cho Docker-based platforms
- `vercel.json`: Config cho Vercel (không khuyến nghị cho app này)
- `netlify.toml`: Config cho Netlify (không khuyến nghị cho app này)
- `railway.yml`: Config cho Railway
- `build.sh`: Script build cho Render

## 🚦 Kiểm tra sau khi deploy:

1. Truy cập URL được cung cấp
2. Kiểm tra WebSocket connection (status indicator)
3. Kiểm tra MQTT connection
4. Test controller commands

## 🔍 Troubleshooting:

- **WebSocket không hoạt động:** Đảm bảo platform hỗ trợ WebSocket
- **MQTT không connect:** Kiểm tra environment variables
- **App crash:** Xem logs của platform để debug

## 📝 Platform so sánh:

| Platform | Miễn phí | WebSocket | Dễ setup | Tự động scaling |
|----------|----------|-----------|----------|-----------------|
| Railway  | ✅ (500h/tháng) | ✅ | ⭐⭐⭐⭐⭐ | ✅ |
| Render   | ✅ (750h/tháng) | ✅ | ⭐⭐⭐⭐ | ✅ |
| Fly.io   | ✅ (Limited) | ✅ | ⭐⭐⭐ | ✅ |
| Vercel   | ✅ | ❌ (Serverless) | ⭐⭐ | ✅ |
| Netlify  | ✅ | ❌ (Static) | ⭐ | ❌ |

**Khuyến nghị:** Railway hoặc Render cho ứng dụng này.
