FROM node:22-alpine

WORKDIR /app

# Keine Abhängigkeiten: Das Paket nutzt nur die Standardbibliothek von Node.js,
# auch für die Datenbank (node:sqlite).
COPY package.json ./
COPY src ./src

# Als Verzeichnis des Nutzers "node" angelegt, damit ein Docker-Volume an
# dieser Stelle beschreibbar ist.
RUN mkdir /data && chown node:node /data
ENV DATA_DIR=/data

USER node
# node:sqlite gilt in Node 22 noch als experimentell; die Warnung dazu wird unterdrückt.
ENTRYPOINT ["node", "--disable-warning=ExperimentalWarning", "src/cli.js"]
CMD ["journal"]
