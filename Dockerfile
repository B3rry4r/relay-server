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
    php8.1-cli \
    php8.1-xml \
    php8.1-mbstring \
    php8.1-curl \
    php8.1-zip \
    composer \
    golang-go \
    default-jdk \
    rustc \
    cargo \
    unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

RUN mkdir -p $WORKSPACE/.relay

CMD ["npm", "start"]