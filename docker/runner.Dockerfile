# Code Duel v2 — image สำหรับรันโค้ดของผู้เล่น (Python 3 + g++ ของ GNU)
# สร้างด้วย: npm run build-runner
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ \
 && rm -rf /var/lib/apt/lists/*

# ผู้ใช้ที่ไม่มีสิทธิ์ root (uid ตรงกับที่ sandbox.js ใช้)
RUN groupadd -g 10001 runner && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin runner

USER 10001:10001
WORKDIR /work
CMD ["sleep", "infinity"]
