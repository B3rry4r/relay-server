FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    WORKSPACE=/workspace \
    AUTH_TOKEN=change_this_to_a_strong_random_string \
    PORT=3000

RUN apt-get update && apt-get install -y ca-certificates curl gnupg

RUN mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodus main" > /etc/apt/sources.list.d/nodesource.list

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
    nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

RUN mkdir -p $WORKSPACE/.relay

CMD ["npm", "start"]