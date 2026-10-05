عالی، چون مرحله ۱، ۲، ۴ و ۵ را انجام داده‌ای، الان فقط باید کانتینری‌سازی را انجام دهی. من یک ساختار استاندارد و بهینه برای Next.js (نسخه ۱۴+ با App Router) + Postgres می‌نویسم که هم برای توسعه و هم برای production روی سرور مناسب باشد.

### ساختار پیشنهادی فایل‌ها در پروژه

```
my-nextjs-app/
├── src/                      (یا app/ بسته به ساختار پروژه‌ات)
├── public/
├── .dockerignore             ← باید بسازی
├── .env                      ← برای لوکال (توی gitignore باشد)
├── .env.production           ← روی سرور (توی gitignore باشد)
├── Dockerfile                ← باید بسازی
├── docker-compose.yml        ← برای production روی سرور
├── docker-compose.dev.yml    ← برای توسعه لوکال
├── next.config.js
├── package.json
└── ...
```

---

### ۱. فایل `next.config.js`

برای اینکه image نهایی داکر خیلی سبک شود، باید حالت `standalone` را فعال کنی.

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // اگر از تصاویر خارجی استفاده می‌کنی، این را هم اضافه کن
  images: {
    remotePatterns: [
      // مثال:
      // { protocol: 'https', hostname: 'example.com' },
    ],
  },
};

module.exports = nextConfig;
```

**چرا؟** حالت `standalone` فقط فایل‌های ضروری runtime را در پوشه `.next/standalone` جمع می‌کند. این باعث می‌شود image نهایی به‌جای چند صد مگابایت، حدود ۱۰۰-۱۵۰ مگابایت شود.

---

### ۲. فایل `.dockerignore`

این فایل باعث می‌شود فایل‌های غیرضروری وارد context داکر نشوند (بیلد سریع‌تر و image کوچک‌تر).

```
node_modules
.next
.git
.gitignore
npm-debug.log
yarn-error.log
Dockerfile
docker-compose*.yml
.env
.env.local
.env.production
README.md
.vscode
.idea
```

---

### ۳. فایل `Dockerfile`

این یک **multi-stage build** است: یعنی در مرحله اول وابستگی‌ها نصب و بیلد می‌شوند، و در مرحله نهایی فقط خروجی نهایی کپی می‌شود.

```dockerfile
# ============================================
# Stage 1: Dependencies (نصب فقط وابستگی‌ها)
# ============================================
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# ============================================
# Stage 2: Builder (بیلد پروژه)
# ============================================
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# متغیرهایی که در زمان build نیاز داری (مثل NEXT_PUBLIC_*)
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ============================================
# Stage 3: Runner (اجرای نهایی)
# ============================================
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# کاربر غیر root برای امنیت
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# کپی فایل‌های ضروری از build
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
```

**نکات مهم:**
- `node:20-alpine` چون سبک است.
- سه مرحله باعث می‌شود image نهایی فقط شامل خروجی بیلد باشد، نه کل `node_modules` اصلی.
- کاربر غیر root برای امنیت (اگر کسی به کانتینر نفوذ کرد، دسترسی root نداشته باشد).
- `NEXT_PUBLIC_*` باید در زمان build ست شود، پس به‌صورت `ARG` پاس داده می‌شود.

---

### ۴. فایل `docker-compose.yml` (برای production روی سرور)

```yaml
services:
  db:
    image: postgres:16-alpine
    container_name: nextjs_db
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - app_network
    # پورت به بیرون expose نمی‌شود، فقط داخل شبکه داکر
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5

  app:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL}
    container_name: nextjs_app
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
      NEXTAUTH_SECRET: ${NEXTAUTH_SECRET}
      NEXTAUTH_URL: ${NEXTAUTH_URL}
    ports:
      # فقط روی localhost باز می‌شود تا Nginx به آن وصل شود
      - "127.0.0.1:3000:3000"
    networks:
      - app_network

volumes:
  postgres_data:
    driver: local

networks:
  app_network:
    driver: bridge
```

**نکات کلیدی این فایل:**
- **پورت دیتابیس به بیرون باز نشده**: فقط داخل شبکه داکر در دسترس است. این خیلی مهم است چون اگر پورت 5432 به بیرون باز باشد، ربات‌ها می‌آیند و تلاش می‌کنند نفوذ کنند.
- **پورت اپ فقط روی `127.0.0.1`**: یعنی فقط Nginx که روی خود سرور است می‌تواند به آن وصل شود. مستقیم از اینترنت قابل دسترس نیست.
- **`depends_on` با `condition: service_healthy`**: اپ صبر می‌کند تا دیتابیس کاملاً آماده شود.
- **volume `postgres_data`**: داده‌ها حتی اگر کانتینر پاک شود، باقی می‌مانند.

---

### ۵. فایل `.env` (لوکال - برای تست)

```env
POSTGRES_USER=myuser
POSTGRES_PASSWORD=mypassword
POSTGRES_DB=mydb

DATABASE_URL=postgresql://myuser:mypassword@localhost:5432/mydb
NEXT_PUBLIC_API_URL=http://localhost:3000
NEXTAUTH_SECRET=some-random-secret
NEXTAUTH_URL=http://localhost:3000
```

⚠️ **این فایل باید در `.gitignore` باشد و هرگز پوش نشود.**

---

### ۶. فایل `docker-compose.dev.yml` (برای توسعه لوکال)

اگر می‌خواهی روی لپ‌تاپ خودت فقط دیتابیس را در داکر اجرا کنی و Next.js را با `npm run dev`:

```yaml
services:
  db:
    image: postgres:16-alpine
    container_name: nextjs_db_dev
    restart: unless-stopped
    environment:
      POSTGRES_USER: myuser
      POSTGRES_PASSWORD: mypassword
      POSTGRES_DB: mydb
    ports:
      - "5432:5432"     # برای dev، پورت باز باشد تا بتونی با DBeaver وصل شی
    volumes:
      - postgres_dev_data:/var/lib/postgresql/data

volumes:
  postgres_dev_data:
```

اجرا:
```bash
docker compose -f docker-compose.dev.yml up -d
```

---

### ۷. نحوه اجرا روی سرور

بعد از اینکه فایل‌ها را روی سرور گذاشتی (مثلاً با `git clone`):

```bash
# 1. فایل .env را روی سرور بساز (با مقادیر production)
nano .env

# 2. بیلد و اجرا
docker compose up -d --build

# 3. لاگ‌ها را ببین
docker compose logs -f app

# 4. بررسی سلامت کانتینرها
docker compose ps
```

---

### ۸. تنظیم Nginx (اگر قبلاً این کار را نکرده‌ای)

فایل `/etc/nginx/sites-available/yourdomain.com`:

```nginx
server {
    listen 80;
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # مهم برای Next.js Streaming
        proxy_buffering off;
    }
}
```

سپس:
```bash
sudo ln -s /etc/nginx/sites-available/yourdomain.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

### ۹. چند نکته مهم که ممکن است به مشکل بخوری

1. **مایگریشن دیتابیس**: اگر از Prisma یا Drizzle استفاده می‌کنی، باید بعد از بالا آمدن دیتابیس، مایگریشن‌ها اجرا شوند. یک راه این است که در `docker-compose.yml` یک سرویس جدا یا در entrypoint اپ این کار را انجام دهی. اگر Prisma داری بگو تا راهنمایی کنم.

2. **`NEXT_PUBLIC_*` در runtime**: این‌ها در زمان build داخل کد inline می‌شوند. پس اگر مقدارشان را در `.env` سرور عوض کردی، باید دوباره بیلد کنی (`--build`).

3. **Persist کردن آپلودها**: اگر اپت فایل آپلود می‌کند، آن پوشه را باید به‌صورت volume در بیاوری وگرنه با هر `--build` پاک می‌شود.

4. **به‌روزرسانی بعدی**: هر بار که کد جدید آمد:
   ```bash
   git pull
   docker compose up -d --build
   ```
   این همان چیزی است که بعداً با GitHub Actions خودکار می‌کنیم.

---

### چک‌لیست نهایی برای الان

- [ ] `next.config.js` را با `output: 'standalone'` ویرایش کن
- [ ] `.dockerignore` را بساز
- [ ] `Dockerfile` را بساز
- [ ] `docker-compose.yml` را بساز
- [ ] `.env` را روی سرور بساز
- [ ] `docker compose up -d --build` را اجرا کن
- [ ] با `curl http://localhost:3000` از خود سرور تست کن
- [ ] از مرورگر با دامین تست کن

اگر Prisma یا Drizzle داری، یا اگر در بیلد به خطا خوردی، خطا را بفرست تا دقیق دیباگ کنیم. بعد از اینکه این مرحله کار کرد، می‌رویم سراغ مرحله ۷ (CI/CD با GitHub Actions).
