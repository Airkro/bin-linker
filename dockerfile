FROM node:lts-alpine AS latest

RUN mkdir -p /home/.share/pnpm /mnt

ENV XDG_DATA_HOME=/home/.share
ENV PNPM_HOME=/home/.share/pnpm
ENV PATH="$PNPM_HOME:$PATH"

RUN pnpm config set storeDir /home/.share/pnpm/store --global

WORKDIR /workspace

RUN pnpm i -g miniprogram-ci
