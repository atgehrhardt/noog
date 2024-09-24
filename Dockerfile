# Use a recent Ubuntu image as the base
FROM ubuntu:22.04

# Avoid prompts from apt
ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies, Node.js, and Playwright dependencies
RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    python3-pip \
    wget \
    gnupg \
    tzdata \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && npx playwright install-deps \
    && apt-get install -y \
        libnss3 \
        libnspr4 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libdbus-1-3 \
        libxkbcommon0 \
        libatspi2.0-0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
    && rm -rf /var/lib/apt/lists/*

# Set the timezone
ENV TZ=America/New_York
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install Node.js dependencies including Playwright
RUN npm install && npm install playwright

# Install Playwright browsers
RUN npx playwright install

# Copy the rest of the application code
COPY . .

# Upgrade pip and install chromadb
RUN pip3 install --upgrade pip && pip3 install chromadb

# Expose the ports the app runs on
EXPOSE 5627

# Command to run the application
CMD ["node", "server.js"]