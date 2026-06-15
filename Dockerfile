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

# Compile the native PTY bridge. The bridge moves the hot read/write loop
# off the Node.js event loop entirely — see native/pty-bridge.c. We need
# libutil for forkpty(), which is part of build-essential on Ubuntu.
RUN gcc -O2 -Wall -Wextra -o /app/native/pty-bridge native/pty-bridge.c -lutil

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    WORKSPACE=/workspace \
    AUTH_TOKEN=change_this_to_a_strong_random_string \
    PORT=3000

RUN apt-get update && apt-get install -y \
    tini \
    gosu \
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
COPY --from=builder /app/native/pty-bridge /app/native/pty-bridge
COPY package.json package-lock.json .
RUN npm ci --omit=dev --ignore-scripts
COPY setup-workspace.sh .

# Non-root user. Claude Code and Flutter refuse to run as root, and Chrome is
# happier non-root too. The volume (/workspace) and /app are handed to dev.
RUN useradd --create-home --shell /bin/bash dev \
    && mkdir -p $WORKSPACE/.relay \
    && chown -R dev:dev $WORKSPACE /app

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# tini reaps orphaned grandchildren (headless Chrome from the screenshot
# endpoints double-forks); without an init, zombies exhaust the pid cgroup.
# entrypoint.sh fixes volume ownership as root, then drops to dev via gosu.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/src/index.js"]
