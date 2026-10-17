FROM node:18

WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install

# Install nodemon globally
RUN npm install -g nodemon

# Copy the rest of the app
COPY . .

EXPOSE 3000

# Use nodemon to run the server for live reload
CMD ["nodemon", "--legacy-watch", "server.js"]
