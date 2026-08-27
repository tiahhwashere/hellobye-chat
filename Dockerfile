FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy application files
COPY index.html server.js enhance.js ./

# Create directories for data and uploads
RUN mkdir -p data uploads

# Expose the port
ENV PORT=3000
EXPOSE 3000

# Start the server
CMD ["npm", "start"]
