FROM node:lts-alpine AS latest

RUN mkdir -p /home/.share/pnpm /mnt

# 固定 pnpm 版本，node 镜像自带的 corepack 会按 package.json 的 packageManager 切换版本
RUN npm i -g pnpm@10

ENV XDG_DATA_HOME=/home/.share
ENV PNPM_HOME=/home/.share/pnpm
ENV PATH="$PNPM_HOME:$PATH"

RUN pnpm config set storeDir /home/.share/pnpm/store --global

WORKDIR /workspace

RUN pnpm i -g miniprogram-ci
