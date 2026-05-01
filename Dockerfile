FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    WORKSPACE=/workspace \
    AUTH_TOKEN=change_this_to_a_strong_random_string \
    PORT=3000

RUN apt-get update && apt-get install -y \
    git \
    curl \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    php-cli \
    php-xml \
    php-mbstring \
    php-curl \
    php-zip \
    composer \
    golang-go \
    default-jdk \
    rustc \
    cargo \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    WORKSPACE=/workspace \
    AUTH_TOKEN=change_this_to_a_strong_random_string \
    PORT=3000

RUN apt-get update && apt-get install -y \
    git \
    curl \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    php-cli \
    php-xml \
    php-mbstring \
    php-curl \
    php-zip \
    composer \
    golang-go \
    default-jdk \
    rustc \
    cargo \
    unzip \
    ca-certificates \
    wget \
    gnupg \
    xvfb \
    x11vnc \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-linux-signing-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-linux-signing-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

ENV RELAY_CHROME_BIN=/usr/bin/google-chrome

RUN curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.gz | tar -xz -C /usr/local --strip-components=1

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY package.json package-lock.json .
RUN npm ci --omit=dev --ignore-scripts
COPY setup-workspace.sh .

RUN mkdir -p $WORKSPACE/.relay

CMD ["node", "dist/src/index.js"]
