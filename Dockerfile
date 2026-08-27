FROM node:20-slim

WORKDIR /app

# Install system libraries that sharp's pre-built libvips binary may
# depend on at runtime. On a slim image these are sometimes missing and
# cause sharp to throw at require-time, crashing the server. Installing
# them ensures the native addon loads cleanly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies.
# We remove any stale node_modules / lock cache first to avoid a corrupted
# build cache producing a broken install.
COPY package.json package-lock.json* ./
RUN npm install --production && npm cache clean --force

# Copy application files
COPY index.html server.js enhance.js ./

# Create directories for data and uploads
RUN mkdir -p data uploads

# Expose the port
ENV PORT=3000
EXPOSE 3000

# Start the server
CMD ["npm", "start"]
