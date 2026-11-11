FROM node:22-alpine

WORKDIR /app

# Keine Abhängigkeiten: Das Paket nutzt nur die Standardbibliothek von Node.js.
COPY package.json ./
COPY src ./src

# Als Verzeichnis des Nutzers "node" angelegt, damit ein Docker-Volume an
# dieser Stelle beschreibbar ist.
RUN mkdir /data && chown node:node /data
ENV DATA_DIR=/data

USER node
ENTRYPOINT ["node", "src/cli.js"]
CMD ["journal"]
