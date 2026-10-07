FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY assets/emoji ./assets/emoji
# Named volume inherits this ownership, so the non-root user can write the db
RUN mkdir /data && chown bun:bun /data
USER bun
ENV DB_PATH=/data/uwucrew.sqlite
EXPOSE 8787
CMD ["bun", "src/index.ts"]
